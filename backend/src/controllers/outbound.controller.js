const db = require('../config/database');

// =====================================================================
// 1. LẤY DANH SÁCH PHIẾU XUẤT (Để xem lịch sử)
// =====================================================================
const getAllOutbounds = (req, res) => {
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
            COALESCE(json_group_array(
                CASE WHEN soi.id IS NOT NULL THEN json_object(
                    'id', soi.id,
                    'product_id', soi.product_id,
                    'product_name', p.name,
                    'product_sku', p.sku,
                    'quantity', soi.quantity,
                    'unit_price', COALESCE(soi.unit_price, 0)
                ) END
            ), '[]') AS items
        FROM stock_outbound_notes o
        LEFT JOIN warehouses w ON o.warehouse_id = w.id
        LEFT JOIN users u ON o.created_by = u.id
        LEFT JOIN sales_orders s ON o.order_id = s.id
        LEFT JOIN customers c ON s.customer_id = c.id
        LEFT JOIN stock_outbound_note_items soi ON o.id = soi.outbound_note_id
        LEFT JOIN products p ON soi.product_id = p.id
        GROUP BY o.id
        ORDER BY o.id DESC
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi lấy danh sách', error: err.message });

        const parsedRows = rows.map((row) => {
            let items = [];
            try {
                const parsed = JSON.parse(row.items || '[]');
                items = parsed.filter((item) => item && item.id != null);
            } catch (parseError) {
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
    });
};

// =====================================================================
// 2. THỦ KHO XÁC NHẬN XUẤT KHO (Backend tự tìm sản phẩm để trừ)
// =====================================================================
const createOutbound = (req, res) => {
    const { outbound_no, order_id, warehouse_id, export_date, note } = req.body;
    const created_by = req.user?.id || 1;

    if (!order_id || !warehouse_id) return res.status(400).json({ message: 'Thiếu thông tin đơn hàng hoặc kho xuất!' });

    // BƯỚC 1: BACKEND TỰ ĐỘNG ĐI TÌM DANH SÁCH MÓN HÀNG CỦA ĐƠN NÀY
    db.all(
        `SELECT soi.product_id, soi.quantity, COALESCE(soi.unit_price, p.sale_price, 0) AS unit_price, p.name, p.sku
         FROM sales_order_items soi
         LEFT JOIN products p ON soi.product_id = p.id
         WHERE soi.order_id = ?`,
        [order_id],
        (err, items) => {
            if (err || items.length === 0) return res.status(400).json({ message: 'Không tìm thấy chi tiết sản phẩm của đơn hàng này!' });

            // BƯỚC 2: Kiểm tra tồn kho của TẤT CẢ sản phẩm trước khi xuất
            const checkStockQueries = items.map(item => {
                return new Promise((resolve, reject) => {
                    db.get(
                        `SELECT b.on_hand_qty, p.name FROM inventory_balances b JOIN products p ON b.product_id = p.id WHERE b.product_id = ? AND b.warehouse_id = ?`,
                        [item.product_id, warehouse_id],
                        (err, row) => {
                            const stock = row ? row.on_hand_qty : 0;
                            if (stock < item.quantity) {
                                reject(`Sản phẩm [${row ? row.name : 'ID:' + item.product_id}] chỉ còn ${stock} cái, không đủ để xuất ${item.quantity} cái!`);
                            } else {
                                resolve();
                            }
                        }
                    );
                });
            });

            // BƯỚC 3: Nếu tất cả đều đủ hàng mới chạy Transaction trừ kho
            Promise.all(checkStockQueries)
                .then(() => {
                    db.serialize(() => {
                        db.run("BEGIN TRANSACTION");

                        db.run(`INSERT INTO stock_outbound_notes (outbound_no, order_id, warehouse_id, export_date, created_by, note, status) VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
                            [outbound_no, order_id, warehouse_id, export_date, created_by, note],
                            function (err) {
                                if (err) { db.run("ROLLBACK"); return res.status(400).json({ message: 'Lỗi tạo mã phiếu xuất!' }); }

                                const outboundId = this.lastID;
                                let completedItems = 0;
                                let hasError = false;

                                const itemsToInsert = items.map(item => ({
                                    product_id: item.product_id,
                                    quantity: item.quantity,
                                    unit_price: item.unit_price ?? 0,
                                }));

                                const processItem = (index) => {
                                    if (index >= itemsToInsert.length) {
                                        db.run(`UPDATE sales_orders SET status = 'shipping', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [order_id]);
                                        db.run("COMMIT");
                                        return res.status(201).json({ message: 'Xuất kho thành công! Đã trừ tồn và cập nhật đơn hàng.', outbound_id: outboundId });
                                    }

                                    const item = itemsToInsert[index];
                                    db.run(
                                        `INSERT INTO stock_outbound_note_items (outbound_note_id, product_id, quantity)
                                     VALUES (?, ?, ?)`,
                                        [outboundId, item.product_id, item.quantity],
                                        function (err) {
                                            if (err) {
                                                hasError = true;
                                                db.run("ROLLBACK");
                                                return res.status(500).json({ message: 'Lỗi lưu chi tiết phiếu xuất!' });
                                            }

                                            db.run(
                                                `UPDATE inventory_balances SET on_hand_qty = on_hand_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE warehouse_id = ? AND product_id = ?`,
                                                [item.quantity, warehouse_id, item.product_id],
                                                function (err) {
                                                    if (err || this.changes === 0) {
                                                        hasError = true;
                                                        db.run("ROLLBACK");
                                                        return res.status(500).json({ message: 'Lỗi cập nhật tồn kho: chưa có dòng tồn kho hoặc không đủ điều kiện cập nhật!' });
                                                    }

                                                    db.run(
                                                        `INSERT INTO inventory_transactions (warehouse_id, product_id, transaction_type, quantity, reference_type, reference_id) VALUES (?, ?, 'OUT', ?, 'stock_outbound', ?)`,
                                                        [warehouse_id, item.product_id, item.quantity, outboundId],
                                                        function (err) {
                                                            if (err) {
                                                                hasError = true;
                                                                db.run("ROLLBACK");
                                                                return res.status(500).json({ message: 'Lỗi ghi lịch sử giao dịch!' });
                                                            }

                                                            completedItems++;
                                                            processItem(index + 1);
                                                        }
                                                    );
                                                }
                                            );
                                        }
                                    );
                                };

                                processItem(0);
                            }
                        );
                    });
                })
                .catch(errorMsg => {
                    res.status(400).json({ message: errorMsg }); // Báo lỗi thiếu hàng
                });
        });
};

// =====================================================================
// 3. HÀM PHẢN HỒI: TỪ CHỐI HOẶC HẸN NGÀY (Khi thiếu hàng)
// =====================================================================
const respondOutbound = (req, res) => {
    const { order_id } = req.params;
    const { action, reason, expected_date } = req.body;

    const newStatus = action === 'reject' ? 'rejected' : 'delayed';
    const notePrefix = action === 'reject' ? '[KHO TỪ CHỐI]' : '[KHO HẸN GIAO]';
    const finalNote = `${notePrefix}: ${reason}`;

    db.run(
        `UPDATE sales_orders SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [newStatus, finalNote, order_id],
        (err) => {
            if (err) return res.status(500).json({ message: 'Lỗi cập nhật phản hồi' });

            db.run(
                `INSERT INTO delivery_requests (order_id, status, logistics_note, warehouse_note, updated_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [order_id, newStatus, reason || null, expected_date || null],
                (err2) => {
                    if (err2) console.error('Lỗi lưu delivery_requests:', err2.message);
                    res.status(200).json({ message: 'Đã gửi phản hồi từ Kho thành công!' });
                }
            );
        }
    );
};

const getPendingOutboundRequests = (req, res) => {
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
            COALESCE(json_group_array(
                CASE WHEN soi.id IS NOT NULL THEN json_object(
                    'id', soi.id,
                    'product_id', soi.product_id,
                    'product_name', p.name,
                    'product_sku', p.sku,
                    'quantity', soi.quantity,
                    'unit_price', COALESCE(soi.unit_price, p.sale_price, 0)
                ) END
            ), '[]') AS items,
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
        GROUP BY s.id
        ORDER BY s.updated_at DESC, s.id DESC
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi lấy danh sách đơn chờ xuất', error: err.message });

        const parsedRows = rows.map((row) => {
            let items = [];
            try {
                items = JSON.parse(row.items || '[]').filter((item) => item && item.id != null);
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
    });
};

const createOutboundFromPending = (req, res) => {
    const { order_id, warehouse_id, export_date, note } = req.body;
    const created_by = req.user?.id || 1;

    if (!order_id || !warehouse_id) return res.status(400).json({ message: 'Thiếu thông tin đơn hàng hoặc kho xuất!' });

    db.all(
        `SELECT soi.product_id, soi.quantity, COALESCE(soi.unit_price, p.sale_price, 0) AS unit_price
         FROM sales_order_items soi
         LEFT JOIN products p ON soi.product_id = p.id
         WHERE soi.order_id = ?`,
        [order_id],
        (err, items) => {
            if (err || items.length === 0) return res.status(400).json({ message: 'Không tìm thấy chi tiết sản phẩm của đơn hàng này!' });

            const checkStockQueries = items.map(item => new Promise((resolve, reject) => {
                db.get(
                    `SELECT b.on_hand_qty, p.name FROM inventory_balances b JOIN products p ON b.product_id = p.id WHERE b.product_id = ? AND b.warehouse_id = ?`,
                    [item.product_id, warehouse_id],
                    (stockErr, row) => {
                        const stock = row ? row.on_hand_qty : 0;
                        if (stock < item.quantity) reject(`Sản phẩm [${row ? row.name : 'ID:' + item.product_id}] chỉ còn ${stock} cái, không đủ để xuất ${item.quantity} cái!`);
                        else resolve();
                    }
                );
            }));

            Promise.all(checkStockQueries)
                .then(() => {
                    db.serialize(() => {
                        db.run('BEGIN TRANSACTION');
                        db.run(
                            `INSERT INTO stock_outbound_notes (outbound_no, order_id, warehouse_id, export_date, created_by, note, status)
                             VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
                            [`XK-${Date.now()}`, order_id, warehouse_id, export_date || new Date().toISOString().split('T')[0], created_by, note || null],
                            function (insertErr) {
                                if (insertErr) {
                                    db.run('ROLLBACK');
                                    return res.status(400).json({ message: 'Lỗi tạo mã phiếu xuất!', error: insertErr.message });
                                }

                                const outboundId = this.lastID;
                                let processed = 0;
                                let hasError = false;

                                items.forEach((item) => {
                                    db.run(
                                        `INSERT INTO stock_outbound_note_items (outbound_note_id, product_id, quantity) VALUES (?, ?, ?)`,
                                        [outboundId, item.product_id, item.quantity],
                                        (itemErr) => { if (itemErr) hasError = true; }
                                    );

                                    db.run(
                                        `UPDATE inventory_balances SET on_hand_qty = on_hand_qty - ?, updated_at = CURRENT_TIMESTAMP WHERE warehouse_id = ? AND product_id = ?`,
                                        [item.quantity, warehouse_id, item.product_id],
                                        (invErr) => { if (invErr) hasError = true; }
                                    );

                                    db.run(
                                        `INSERT INTO inventory_transactions (warehouse_id, product_id, transaction_type, quantity, reference_type, reference_id)
                                         VALUES (?, ?, 'OUT', ?, 'stock_outbound', ?)`,
                                        [warehouse_id, item.product_id, item.quantity, outboundId],
                                        (txErr) => {
                                            if (txErr) hasError = true;
                                            processed += 1;

                                            if (processed === items.length) {
                                                if (hasError) {
                                                    db.run('ROLLBACK');
                                                    return res.status(500).json({ message: 'Lỗi trừ tồn kho hoặc lưu chi tiết phiếu xuất!' });
                                                }

                                                db.run(`UPDATE sales_orders SET status = 'shipping', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [order_id]);
                                                db.run('COMMIT');
                                                return res.status(201).json({ message: 'Xuất kho thành công! Đã trừ tồn và cập nhật đơn hàng.', outbound_id: outboundId });
                                            }
                                        }
                                    );
                                });
                            }
                        );
                    });
                })
                .catch(errorMsg => res.status(400).json({ message: errorMsg }));
        }
    );
};

const createOutboundFallback = (req, res) => {
    res.status(501).json({ message: 'Chưa hỗ trợ' });
};

module.exports = { getAllOutbounds, getPendingOutboundRequests, createOutbound, createOutboundFromPending, respondOutbound, createOutboundFallback };