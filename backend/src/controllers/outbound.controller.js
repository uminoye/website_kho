const pool = require('../config/database');

// =====================================================================
// 1. LẤY DANH SÁCH PHIẾU XUẤT (Để xem lịch sử)
// =====================================================================
const getAllOutbounds = async (req, res) => {
    const query = `
        SELECT
            o.id,
            o.outbound_no,
            o.order_id,
            o.warehouse_id,
            o.export_date,
            o.created_by,
            o.status,
            o.note,
            o.created_at,
            o.updated_at,
            s.order_no,
            s.order_date,
            s.expected_delivery_date,
            s.actual_delivery_date,
            s.status AS order_status,
            s.note AS order_note,
            s.created_at AS order_created_at,
            c.company_name AS customer_name,
            c.phone AS customer_phone,
            c.address AS customer_address,
            w.name AS warehouse_name,
            w.warehouse_code AS warehouse_code,
            u.full_name AS creator_name,
            COALESCE(SUM(soi.quantity * COALESCE(soi.unit_price, 0)), 0) AS total_amount,
             COALESCE(
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                    'id', soi.id,
                    'product_id', soi.product_id,
                    'product_name', p.name,
                    'product_sku', p.sku,
                    'quantity', soi.quantity,
                    'unit_price', COALESCE(soi.unit_price, 0)
                 )
                ) FILTER (WHERE soi.id IS NOT NULL), '[]'::json
            ) AS items
        FROM stock_outbound_notes o
        LEFT JOIN warehouses w ON o.warehouse_id = w.id
        LEFT JOIN users u ON o.created_by = u.id
        LEFT JOIN sales_orders s ON o.order_id = s.id
        LEFT JOIN customers c ON s.customer_id = c.id
        LEFT JOIN stock_outbound_note_items soi ON o.id = soi.outbound_note_id
        LEFT JOIN products p ON soi.product_id = p.id
        GROUP BY o.id, s.id, c.id, w.id, u.id
        ORDER BY o.id DESC
    `;

    try {
        const { rows } = await pool.query(query);

        const parsedRows = rows.map((row) => {
            let items = Array.isArray(row.items) ? row.items : [];
            if (typeof row.items === 'string') {
                try { items = JSON.parse(row.items); } catch (e) { }
            }
            items = items.filter((item) => item && item.id != null);


            return {
                id: row.id,
                order_no: row.order_no,
                order_date: row.order_date,
                expected_delivery_date: row.expected_delivery_date,
                actual_delivery_date: row.actual_delivery_date,
                customer_name: row.customer_name,
                customer_phone: row.customer_phone,
                customer_address: row.customer_address,
                total_amount: Number(row.total_amount || 0),
                items,
                delivery_status: row.delivery_status,
                delivery_note: row.delivery_note,
                warehouse_note: row.warehouse_note,
                status: row.order_status,
                order_status: row.order_status,
                created_at: row.created_at,
                updated_at: row.updated_at,
            };
        });

        res.status(200).json(parsedRows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi lấy danh sách', error: err.message });
    }
};

// =====================================================================
// 2. THỦ KHO XÁC NHẬN XUẤT KHO (Backend tự tìm sản phẩm để trừ)
const createOutbound = async (req, res) => {
    const { outbound_no, order_id, warehouse_id, export_date, note } = req.body;
    const created_by = req.user?.id || 1;

    if (!order_id || !warehouse_id) return res.status(400).json({ message: 'Thiếu thông tin đơn hàng hoặc kho xuất!' });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const { rows: items } = await client.query(
            `SELECT soi.product_id, soi.quantity, COALESCE(soi.unit_price, p.sale_price, 0) AS unit_price, p.name, p.sku
             FROM sales_order_items soi
             LEFT JOIN products p ON soi.product_id = p.id
             WHERE soi.order_id = $1`,
            [order_id]
        );

        if (!items || items.length === 0) throw new Error('Không tìm thấy chi tiết sản phẩm của đơn hàng này!');
        for (const item of items) {
            const { rows: stockRows } = await client.query(
                `SELECT b.on_hand_qty, p.name FROM inventory_balances b JOIN products p ON b.product_id = p.id WHERE b.product_id = $1 AND b.warehouse_id = $2`,
                [item.product_id, warehouse_id]
            );
            const stock = stockRows.length > 0 ? stockRows[0].on_hand_qty : 0;
            if (stock < item.quantity) {
                throw new Error(`Sản phẩm [${stockRows.length > 0 ? stockRows[0].name : 'ID:' + item.product_id}] chỉ còn ${stock} cái, không đủ để xuất ${item.quantity} cái!`);
            }
        }

        const outResult = await client.query(
            `INSERT INTO stock_outbound_notes (outbound_no, order_id, warehouse_id, export_date, created_by, note, status) VALUES ($1, $2, $3, $4, $5, $6, 'completed') RETURNING id`,
            [outbound_no, order_id, warehouse_id, export_date, created_by, note]
        );
        const outboundId = outResult.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO stock_outbound_note_items (outbound_note_id, product_id, quantity) VALUES ($1, $2, $3)`,
                [outboundId, item.product_id, item.quantity]
            );

            const updateRes = await client.query(
                `UPDATE inventory_balances SET on_hand_qty = on_hand_qty - $1, updated_at = CURRENT_TIMESTAMP WHERE warehouse_id = $2 AND product_id = $3`,
                [item.quantity, warehouse_id, item.product_id]
            );

            if (updateRes.rowCount === 0) {
                throw new Error('Lỗi cập nhật tồn kho: chưa có dòng tồn kho hoặc không đủ điều kiện cập nhật!');
            }

            await client.query(
                `INSERT INTO inventory_transactions (warehouse_id, product_id, transaction_type, quantity, reference_type, reference_id) VALUES ($1, $2, 'OUT', $3, 'stock_outbound', $4)`,
                [warehouse_id, item.product_id, item.quantity, outboundId]
            );
        }

        await client.query(`UPDATE sales_orders SET status = 'shipping', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [order_id]);

        await client.query("COMMIT");
        return res.status(201).json({ message: 'Xuất kho thành công! Đã trừ tồn và cập nhật đơn hàng.', outbound_id: outboundId });
    } catch (err) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: err.message || 'Lỗi xử lý xuất kho' });
    } finally {
        client.release();
    }
};

// =====================================================================
// 3. HÀM PHẢN HỒI: TỪ CHỐI HOẶC HẸN NGÀY (Khi thiếu hàng)
// =====================================================================
const respondOutbound = async (req, res) => {
    const { order_id } = req.params;
    const { action, reason, expected_date } = req.body;

    const newStatus = action === 'reject' ? 'rejected' : 'delayed';
    const notePrefix = action === 'reject' ? '[KHO TỪ CHỐI]' : '[KHO HẸN GIAO]';
    const finalNote = `${notePrefix}: ${reason}`;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE sales_orders SET status = $1, note = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
            [newStatus, finalNote, order_id]
        );

        await client.query(
            `INSERT INTO delivery_requests (order_id, status, logistics_note, warehouse_note, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
            [order_id, newStatus, reason || null, expected_date || null]
        );
        await client.query("COMMIT");
        res.status(200).json({ message: 'Đã gửi phản hồi từ Kho thành công!' });
    } catch (err) {
        await client.query("ROLLBACK");
        res.status(500).json({ message: 'Lỗi cập nhật phản hồi', error: err.message });
    } finally {
        client.release();
    }
};


const getPendingOutboundRequests = async (req, res) => {
    const query = `
        SELECT
            s.id,
            s.order_no,
            s.order_date,
            s.expected_delivery_date,
            CASE 
                WHEN s.status IN ('canceled', 'returned') THEN NULL 
                ELSE s.actual_delivery_date 
            END AS actual_delivery_date,
            s.status AS order_status,
            s.note AS order_note,
            s.created_at,
            s.updated_at,
            c.company_name AS customer_name,
            c.phone AS customer_phone,
            c.address AS customer_address,
            COALESCE(SUM(soi.quantity * COALESCE(soi.unit_price, p.sale_price, 0)), 0) AS total_amount,
                    COALESCE(
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                    'id', soi.id,
                    'product_id', soi.product_id,
                    'product_name', p.name,
                    'product_sku', p.sku,
                    'quantity', soi.quantity,
                    'unit_price', COALESCE(soi.unit_price, p.sale_price, 0)
                 )
                ) FILTER (WHERE soi.id IS NOT NULL), '[]'::json
            ) AS items,
            (
                SELECT d.status
                FROM delivery_requests d
                WHERE d.order_id = s.id
                ORDER BY d.id DESC
                LIMIT 1
            ) AS delivery_status,
            (
                SELECT d.logistics_note
                FROM delivery_requests d
                WHERE d.order_id = s.id
                ORDER BY d.id DESC
                LIMIT 1
            ) AS delivery_note,
            (
                SELECT d.warehouse_note
                FROM delivery_requests d
                WHERE d.order_id = s.id
                ORDER BY d.id DESC
                LIMIT 1
            ) AS warehouse_note,
            -- 👉 ĐÃ THÊM: Lấy thông tin Kho và Ngày xuất để lọc & hiển thị
            (
                SELECT son.warehouse_id
                FROM stock_outbound_notes son
                WHERE son.order_id = s.id
                ORDER BY son.id DESC
                LIMIT 1
            ) AS warehouse_id,
            (
                SELECT w.name
                FROM stock_outbound_notes son
                JOIN warehouses w ON w.id = son.warehouse_id
                WHERE son.order_id = s.id
                ORDER BY son.id DESC
                LIMIT 1
            ) AS warehouse_name,
            (
                SELECT son.export_date
                FROM stock_outbound_notes son
                WHERE son.order_id = s.id
                ORDER BY son.id DESC
                LIMIT 1
            ) AS export_date
        FROM sales_orders s
        LEFT JOIN customers c ON s.customer_id = c.id
        LEFT JOIN sales_order_items soi ON s.id = soi.order_id
        LEFT JOIN products p ON soi.product_id = p.id
        WHERE s.status IN ('warehouse_processing', 'shipping', 'completed', 'returned', 'canceled')
            OR EXISTS (
                SELECT 1
                FROM delivery_requests d
                WHERE d.order_id = s.id
                    AND COALESCE(d.status, '') IN ('warehouse_processing', 'shipping', 'completed', 'returned', 'canceled')
            )
        GROUP BY s.id, c.id
        ORDER BY s.updated_at DESC, s.id DESC
    `;

    try {
        const { rows } = await pool.query(query);
        const parsedRows = rows.map((row) => {
            let items = [];
            try {
                  let rawItems = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
                items = (rawItems || []).filter((item) => item && item.id != null);
            } catch (e) {
                items = [];
            }

            return {
                id: row.id,
                order_no: row.order_no,
                order_date: row.order_date,
                expected_delivery_date: row.expected_delivery_date,
                actual_delivery_date: row.actual_delivery_date,
                customer_name: row.customer_name,
                customer_phone: row.customer_phone,
                customer_address: row.customer_address,
                note: row.order_note || null,
                total_amount: Number(row.total_amount || 0),
                items,
                delivery_status: row.delivery_status,
                delivery_note: row.delivery_note,
                warehouse_note: row.warehouse_note,
                status: row.order_status,
                order_status: row.order_status,
                created_at: row.created_at,
                updated_at: row.updated_at,
                // 👉 Bơm 3 trường này về cho Frontend xài
                warehouse_id: row.warehouse_id,
                warehouse_name: row.warehouse_name,
                export_date: row.export_date
            };
        });

        res.status(200).json(parsedRows);
  } catch (err) {
        res.status(500).json({ message: 'Lỗi lấy danh sách đơn chờ xuất', error: err.message });
    }
};

const createOutboundFromPending = async (req, res) => {
    const { order_id, warehouse_id, export_date, note } = req.body;
    const created_by = req.user?.id || 1;

    if (!order_id || !warehouse_id) return res.status(400).json({ message: 'Thiếu thông tin đơn hàng hoặc kho xuất!' });

     const client = await pool.connect();
    try {
        await client.query("BEGIN");
            const { rows: items } = await client.query(
            `SELECT soi.product_id, soi.quantity, COALESCE(soi.unit_price, p.sale_price, 0) AS unit_price
             FROM sales_order_items soi
             LEFT JOIN products p ON soi.product_id = p.id
             WHERE soi.order_id = $1`,
            [order_id]
        );

        if (!items || items.length === 0) throw new Error('Không tìm thấy chi tiết sản phẩm của đơn hàng này!');

        for (const item of items) {
            const { rows: stockRows } = await client.query(
                `SELECT b.on_hand_qty, p.name FROM inventory_balances b JOIN products p ON b.product_id = p.id WHERE b.product_id = $1 AND b.warehouse_id = $2`,
                [item.product_id, warehouse_id]
            );
            const stock = stockRows.length > 0 ? stockRows[0].on_hand_qty : 0;
            if (stock < item.quantity) {
                throw new Error(`Sản phẩm [${stockRows.length > 0 ? stockRows[0].name : 'ID:' + item.product_id}] chỉ còn ${stock} cái, không đủ để xuất ${item.quantity} cái!`);
            }
        }

        const outResult = await client.query(
            `INSERT INTO stock_outbound_notes (outbound_no, order_id, warehouse_id, export_date, created_by, note, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'completed') RETURNING id`,
            [`XK-${Date.now()}`, order_id, warehouse_id, export_date || new Date().toISOString().split('T')[0], created_by, note || null]
        );
        const outboundId = outResult.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO stock_outbound_note_items (outbound_note_id, product_id, quantity) VALUES ($1, $2, $3)`,
                [outboundId, item.product_id, item.quantity]
            );

            await client.query(
                `UPDATE inventory_balances SET on_hand_qty = on_hand_qty - $1, updated_at = CURRENT_TIMESTAMP WHERE warehouse_id = $2 AND product_id = $3`,
                [item.quantity, warehouse_id, item.product_id]
            );

            await client.query(
                `INSERT INTO inventory_transactions (warehouse_id, product_id, transaction_type, quantity, reference_type, reference_id)
                 VALUES ($1, $2, 'OUT', $3, 'stock_outbound', $4)`,
                [warehouse_id, item.product_id, item.quantity, outboundId]
            );
        }

        await client.query(`UPDATE sales_orders SET status = 'shipping', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [order_id]);

        await client.query("COMMIT");
        return res.status(201).json({ message: 'Xuất kho thành công! Đã trừ tồn và cập nhật đơn hàng.', outbound_id: outboundId });

    } catch (err) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: err.message || 'Lỗi trừ tồn kho hoặc lưu chi tiết phiếu xuất!' });
    } finally {
        client.release();
    }
};

const createOutboundFallback = (req, res) => {
    res.status(501).json({ message: 'Chưa hỗ trợ' });
};

module.exports = { getAllOutbounds, getPendingOutboundRequests, createOutbound, createOutboundFromPending, respondOutbound, createOutboundFallback };