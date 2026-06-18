const pool = require('../config/database');

// 1. Lấy danh sách tất cả đơn hàng kèm chi tiết sản phẩm
const getAllOrders = async (req, res) => {
    const query = `
        SELECT
            o.id,
            o.order_no,
            o.customer_id,
            c.company_name as customer_name,
            o.order_date,
            o.expected_delivery_date,
            o.actual_delivery_date,
            o.created_by,
            o.status,
            o.note,
            o.created_at,
            o.updated_at,
            oi.id as item_id,
            oi.product_id,
            oi.quantity,
            oi.unit_price,
            p.name as product_name,
            p.sku as product_sku
        FROM sales_orders o
        JOIN customers c ON o.customer_id = c.id
        LEFT JOIN sales_order_items oi ON oi.order_id = o.id
        LEFT JOIN products p ON p.id = oi.product_id
        ORDER BY o.created_at DESC, oi.id ASC
    `;

    try {
        const { rows } = await pool.query(query);
        const ordersMap = new Map();

        rows.forEach((row) => {
            if (!ordersMap.has(row.id)) {
                ordersMap.set(row.id, {
                    id: row.id,
                    order_no: row.order_no,
                    customer_id: row.customer_id,
                    customer_name: row.customer_name,
                    order_date: row.order_date,
                    expected_delivery_date: row.expected_delivery_date,
                    actual_delivery_date: row.actual_delivery_date,
                    created_by: row.created_by,
                    status: row.status,
                    note: row.note,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    items: [],
                });
            }

            if (row.item_id) {
                ordersMap.get(row.id).items.push({
                    id: row.item_id,
                    product_id: row.product_id,
                    product_name: row.product_name,
                    product_sku: row.product_sku,
                    quantity: row.quantity,
                    unit_price: row.unit_price,
                });
            }
        });

        res.status(200).json(Array.from(ordersMap.values()));
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
    }
};

// 2. Lấy chi tiết các sản phẩm bên trong 1 đơn hàng (Dùng khi Sửa đơn hoặc Báo lỗi)
const getOrderItems = async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query(`SELECT * FROM sales_order_items WHERE order_id = $1`, [id]);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
    }
};

// 3. Sales tạo đơn hàng mới
const createOrder = async (req, res) => {
    const { order_no, customer_id, order_date, expected_delivery_date, note, items } = req.body;
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Thêm cột status và gán mặc định là 'pending', RETURNING id để lấy orderId vừa tạo
        const orderResult = await client.query(
            `INSERT INTO sales_orders (order_no, customer_id, order_date, expected_delivery_date, note, status) VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
            [order_no, customer_id, order_date, expected_delivery_date, note]
        );
        
        const orderId = orderResult.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO sales_order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)`,
                [orderId, item.product_id, item.quantity, item.unit_price]
            );
        }

        await client.query("COMMIT");
        res.status(201).json({ message: 'Tạo đơn hàng thành công', id: orderId });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("LỖI DATABASE KHI TẠO ĐƠN:", err.message);
        res.status(500).json({ message: 'Lỗi Database: ' + err.message });
    } finally {
        client.release();
    }
};

// 4. Sales cập nhật toàn bộ đơn hàng (Sửa & Gửi lại)
const updateOrder = async (req, res) => {
    const orderId = req.params.id;
    const { customer_id, expected_delivery_date, note, items } = req.body;
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        // Đưa trạng thái về lại 'pending' để Logistics duyệt lại
        await client.query(
            `UPDATE sales_orders SET customer_id = $1, expected_delivery_date = $2, note = $3, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
            [customer_id, expected_delivery_date, note, orderId]
        );

        // Xóa toàn bộ sản phẩm cũ của đơn hàng
        await client.query(`DELETE FROM sales_order_items WHERE order_id = $1`, [orderId]);

        // Thêm lại danh sách sản phẩm mới mà Sales vừa sửa
        for (const item of items) {
            await client.query(
                `INSERT INTO sales_order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)`,
                [orderId, item.product_id, item.quantity, item.unit_price]
            );
        }

        await client.query("COMMIT");
        res.status(200).json({ message: 'Đã cập nhật toàn bộ đơn hàng!' });
    } catch (err) {
        await client.query("ROLLBACK");
        res.status(500).json({ message: 'Lỗi cập nhật đơn', error: err.message });
    } finally {
        client.release();
    }
};

// 5. Xóa đơn hàng (Chỉ cho phép xóa khi đơn đang chờ duyệt hoặc bị từ chối)
const deleteOrder = async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        const { rows } = await client.query(`SELECT status FROM sales_orders WHERE id = $1`, [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });

        // ÉP KIỂU: Nếu status là null hoặc trống thì coi như là 'pending'
        const row = rows[0];
        const currentStatus = row.status || 'pending';

        if (currentStatus !== 'pending' && currentStatus !== 'returned') {
            return res.status(400).json({ message: 'Không thể xóa đơn hàng đã được xử lý hoặc hoàn thành!' });
        }

        await client.query('BEGIN');
        await client.query(`DELETE FROM sales_order_items WHERE order_id = $1`, [id]);
        await client.query(`DELETE FROM sales_orders WHERE id = $1`, [id]);
        await client.query('COMMIT');
        
        res.status(200).json({ message: 'Đã xóa đơn hàng thành công' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Lỗi khi xóa', error: err.message });
    } finally {
        client.release();
    }
};

// 6. Logistics xử lý đơn (Duyệt hoặc Từ chối có lý do)
const processLogistics = async (req, res) => {
    const { order_id, new_status, reason_type, detail_note } = req.body;

    let finalNote = '';
    if (new_status === 'returned') {
        finalNote = `[LOGISTICS TỪ CHỐI]: ${reason_type} | Chi tiết: ${detail_note}`;
    } else {
        finalNote = detail_note;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `UPDATE sales_orders SET status = $1, note = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
            [new_status, finalNote, order_id]
        );

        await client.query(
            `INSERT INTO delivery_requests (order_id, handled_by, received_at, status, logistics_note, warehouse_note)
             VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4, null)`,
            [order_id, req.user?.id || null, new_status, finalNote]
        );

        await client.query('COMMIT');
        
        if (new_status === 'warehouse_processing') {
            return res.status(200).json({ message: 'Đã cập nhật trạng thái đơn hàng và tạo yêu cầu xuất kho!' });
        } else {
            return res.status(200).json({ message: 'Đã cập nhật trạng thái đơn hàng!' });
        }
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Lỗi khi xử lý đơn hàng', error: err.message });
    } finally {
        client.release();
    }
};

// 7. Kho báo lỗi (Thiếu hàng, hẹn ngày...) -> Gửi về cho Logistics
const reportWarehouseIssue = async (req, res) => {
    const { id } = req.params;
    const { issue_note } = req.body;

    try {
        const { rows } = await pool.query(`SELECT note FROM sales_orders WHERE id = $1`, [id]);
        const currentNote = rows.length > 0 ? (rows[0].note || '') : '';
        const newNote = `[KHO BÁO LỖI]: ${issue_note} | Ghi chú cũ: ${currentNote}`;

        await pool.query(
            `UPDATE sales_orders SET status = 'logistics_review', note = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [newNote, id]
        );
        res.status(200).json({ message: 'Đã báo lỗi và gửi về cho Logistics!' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi khi báo thiếu hàng', error: err.message });
    }
};
// 8. Xuất kho: Đổi từ 'completed' sang 'shipping' (Đang giao)
const exportOrder = async (req, res) => {
    const orderId = req.params.id;
    const { warehouse_id } = req.body;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // ... (giữ nguyên đoạn INSERT stock_outbound_notes và SELECT items)
        // Chỉ sửa dòng Update status dưới đây:
        await client.query(
            `UPDATE sales_orders SET status = 'shipping', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, 
            [orderId]
        );
        await client.query("COMMIT");
        res.status(200).json({ message: 'Đã xuất kho, đơn hàng chuyển sang trạng thái Đang giao!' });
    } catch (err) {
        await client.query("ROLLBACK");
        res.status(500).json({ message: 'Lỗi chốt đơn', error: err.message });
    } finally {
        client.release();
    }
};

// 9. HÀM MỚI: Xác nhận đã giao hàng thành công (Logistics bấm)
const confirmDelivery = async (req, res) => {
    const orderId = req.params.id;
    try {
        await pool.query(
            `UPDATE sales_orders SET status = 'completed', actual_delivery_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [orderId]
        );
        res.status(200).json({ message: 'Xác nhận đơn hàng đã giao thành công!' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi xác nhận giao hàng', error: err.message });
    }
};

// 10. HÀM HỦY ĐƠN: XỬ LÝ CẢ TRƯỜNG HỢP "BOM HÀNG" LẪN "BỊ TỪ CHỐI/HỦY SỚM"
const returnInventory = async (req, res) => {
    const orderId = req.params.id;
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        // BƯỚC 1: Tìm xem đơn này ĐÃ TỪNG XUẤT KHO CHƯA (Có nằm trong bảng phiếu xuất không?)
        const { rows: outboundRows } = await client.query(
            `SELECT warehouse_id FROM stock_outbound_notes WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
            [orderId]
        );
        const outbound = outboundRows[0];

        if (outbound) {
            // ==============================================================
            // TRƯỜNG HỢP 1: ĐÃ XUẤT KHO (BOM HÀNG) -> PHẢI HOÀN KHO
            // ==============================================================
            const oldWarehouseId = outbound.warehouse_id;

            const { rows: items } = await client.query(`SELECT product_id, quantity FROM sales_order_items WHERE order_id = $1`, [orderId]);
            if (!items || items.length === 0) {
                throw new Error('Lỗi lấy dữ liệu sản phẩm để hoàn kho');
            }

            for (const item of items) {
                // PostgreSQL sử dụng COALESCE thay cho IFNULL
                await client.query(
                    `UPDATE inventory_balances SET on_hand_qty = COALESCE(on_hand_qty, 0) + $1 
                     WHERE product_id = $2 AND warehouse_id = $3`,
                    [item.quantity, item.product_id, oldWarehouseId]
                );
            }

            // Đồng bộ trạng thái đơn sau khi hoàn kho là 'canceled' để frontend hiển thị đúng là hủy đơn
            await client.query(
                `UPDATE sales_orders SET status = 'canceled', actual_delivery_date = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [orderId]
            );
            
            await client.query("COMMIT");
            res.status(200).json({ message: `Bom hàng: Đã hoàn trả tồn kho về Kho ID ${oldWarehouseId} và cập nhật trạng thái hủy đơn!` });
        } else {
            // ==============================================================
            // TRƯỜNG HỢP 2: CHƯA XUẤT KHO (LOGISTICS TỪ CHỐI HOẶC SALE HỦY)
            // ==============================================================
            // Kho chưa bị trừ hàng, nên CHỈ CẦN đổi trạng thái đơn thành Hủy là xong!
            
            await client.query(
                `UPDATE sales_orders SET status = 'returned', actual_delivery_date = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [orderId]
            );
            await client.query("COMMIT");
            res.status(200).json({ message: 'Đã cập nhật đơn thành trạng thái hoàn trả/từ chối.' });
        }
    } catch (err) {
        await client.query("ROLLBACK");
        res.status(500).json({ message: 'Lỗi kiểm tra/hoàn kho', error: err.message });
    } finally {
        client.release();
    }
};
// Khai báo công khai toàn bộ 8 hàm để file Route có thể sử dụng
module.exports = {
    getAllOrders,
    getOrderItems,
    createOrder,
    updateOrder,
    deleteOrder,
    processLogistics,
    reportWarehouseIssue,
    exportOrder,
    confirmDelivery,
    returnInventory
};