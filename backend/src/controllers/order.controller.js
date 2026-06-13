const db = require('../config/database');

// 1. Lấy danh sách tất cả đơn hàng kèm chi tiết sản phẩm
const getAllOrders = (req, res) => {
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

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });

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
    });
};

// 2. Lấy chi tiết các sản phẩm bên trong 1 đơn hàng (Dùng khi Sửa đơn hoặc Báo lỗi)
const getOrderItems = (req, res) => {
    const { id } = req.params;
    db.all(`SELECT * FROM sales_order_items WHERE order_id = ?`, [id], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi máy chủ' });
        res.status(200).json(rows);
    });
};

// 3. Sales tạo đơn hàng mới
const createOrder = (req, res) => {
    const { order_no, customer_id, order_date, expected_delivery_date, note, items } = req.body;

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        // ĐÃ SỬA LỖI 1: Thêm cột status và gán mặc định là 'pending'
        db.run(
            `INSERT INTO sales_orders (order_no, customer_id, order_date, expected_delivery_date, note, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
            [order_no, customer_id, order_date, expected_delivery_date, note],
            function (err) {
                if (err) {
                    console.error("LỖI DATABASE KHI TẠO ĐƠN:", err.message);
                    db.run("ROLLBACK");
                    return res.status(500).json({ message: 'Lỗi Database: ' + err.message });
                }

                const orderId = this.lastID;
                let completedItems = 0;
                let hasError = false;

                items.forEach(item => {
                    if (hasError) return;
                    db.run(`INSERT INTO sales_order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)`,
                        [orderId, item.product_id, item.quantity, item.unit_price], (err) => {
                            if (err) {
                                console.error("LỖI LƯU SẢN PHẨM:", err.message);
                                hasError = true;
                            }

                            completedItems++;
                            if (completedItems === items.length) {
                                if (hasError) {
                                    db.run("ROLLBACK");
                                    res.status(500).json({ message: 'Lỗi lưu sản phẩm vào đơn' });
                                } else {
                                    db.run("COMMIT");
                                    res.status(201).json({ message: 'Tạo đơn hàng thành công', id: orderId });
                                }
                            }
                        });
                });
            }
        );
    });
};

// 4. Sales cập nhật toàn bộ đơn hàng (Sửa & Gửi lại)
const updateOrder = (req, res) => {
    const orderId = req.params.id;
    const { customer_id, expected_delivery_date, note, items } = req.body;

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        // Đưa trạng thái về lại 'pending' để Logistics duyệt lại
        db.run(
            `UPDATE sales_orders SET customer_id = ?, expected_delivery_date = ?, note = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [customer_id, expected_delivery_date, note, orderId],
            function (err) {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ message: 'Lỗi cập nhật đơn' }); }

                // Xóa toàn bộ sản phẩm cũ của đơn hàng
                db.run(`DELETE FROM sales_order_items WHERE order_id = ?`, [orderId], function (err) {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ message: 'Lỗi xóa chi tiết cũ' }); }

                    let completedItems = 0;
                    let hasError = false;

                    // Thêm lại danh sách sản phẩm mới mà Sales vừa sửa
                    items.forEach(item => {
                        if (hasError) return;

                        // ĐÃ SỬA LỖI 2 CHÍ MẠNG: Đổi thành INSERT INTO sales_order_items
                        db.run(`INSERT INTO sales_order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)`,
                            [orderId, item.product_id, item.quantity, item.unit_price], (err) => {
                                if (err) hasError = true;

                                completedItems++;
                                if (completedItems === items.length) {
                                    if (hasError) {
                                        db.run("ROLLBACK");
                                        res.status(500).json({ message: 'Lỗi lưu sản phẩm mới' });
                                    } else {
                                        db.run("COMMIT");
                                        res.status(200).json({ message: 'Đã cập nhật toàn bộ đơn hàng!' });
                                    }
                                }
                            });
                    });
                });
            }
        );
    });
};

// 5. Xóa đơn hàng (Chỉ cho phép xóa khi đơn đang chờ duyệt hoặc bị từ chối)
const deleteOrder = (req, res) => {
    const { id } = req.params;
    db.get(`SELECT status FROM sales_orders WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ message: 'Lỗi máy chủ' });
        if (!row) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });

        // ÉP KIỂU: Nếu status là null hoặc trống thì coi như là 'pending'
        const currentStatus = row.status || 'pending';

        if (currentStatus !== 'pending' && currentStatus !== 'returned') {
            return res.status(400).json({ message: 'Không thể xóa đơn hàng đã được xử lý hoặc hoàn thành!' });
        }

        db.serialize(() => {
            db.run(`DELETE FROM sales_order_items WHERE order_id = ?`, [id]);
            db.run(`DELETE FROM sales_orders WHERE id = ?`, [id], function (err) {
                if (err) return res.status(500).json({ message: 'Lỗi khi xóa' });
                res.status(200).json({ message: 'Đã xóa đơn hàng thành công' });
            });
        });
    });
};

// 6. Logistics xử lý đơn (Duyệt hoặc Từ chối có lý do)
const processLogistics = (req, res) => {
    const { order_id, new_status, reason_type, detail_note } = req.body;

    let finalNote = '';
    if (new_status === 'returned') {
        finalNote = `[LOGISTICS TỪ CHỐI]: ${reason_type} | Chi tiết: ${detail_note}`;
    } else {
        finalNote = detail_note;
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run(
            `UPDATE sales_orders SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [new_status, finalNote, order_id],
            function (err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ message: 'Lỗi khi xử lý đơn hàng' });
                }

                if (new_status === 'warehouse_processing') {
                    db.run(
                        `INSERT INTO delivery_requests (order_id, handled_by, received_at, status, logistics_note, warehouse_note)
                         VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
                        [order_id, req.user?.id || null, new_status, finalNote, null],
                        function (reqErr) {
                            if (reqErr) {
                                db.run('ROLLBACK');
                                return res.status(500).json({ message: 'Lỗi tạo yêu cầu xuất kho', error: reqErr.message });
                            }

                            db.run('COMMIT');
                            return res.status(200).json({ message: 'Đã cập nhật trạng thái đơn hàng và tạo yêu cầu xuất kho!' });
                        }
                    );
                } else {
                    db.run(
                        `INSERT INTO delivery_requests (order_id, handled_by, received_at, status, logistics_note, warehouse_note)
                         VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
                        [order_id, req.user?.id || null, new_status, finalNote, null],
                        function (reqErr) {
                            if (reqErr) {
                                db.run('ROLLBACK');
                                return res.status(500).json({ message: 'Lỗi lưu lịch sử logistics', error: reqErr.message });
                            }

                            db.run('COMMIT');
                            return res.status(200).json({ message: 'Đã cập nhật trạng thái đơn hàng!' });
                        }
                    );
                }
            }
        );
    });
};

// 7. Kho báo lỗi (Thiếu hàng, hẹn ngày...) -> Gửi về cho Logistics
const reportWarehouseIssue = (req, res) => {
    const { id } = req.params;
    const { issue_note } = req.body;

    db.get(`SELECT note FROM sales_orders WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ message: 'Lỗi máy chủ' });

        const currentNote = row ? (row.note || '') : '';
        const newNote = `[KHO BÁO LỖI]: ${issue_note} | Ghi chú cũ: ${currentNote}`;

        db.run(
            `UPDATE sales_orders SET status = 'logistics_review', note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [newNote, id],
            function (err) {
                if (err) return res.status(500).json({ message: 'Lỗi khi báo thiếu hàng' });
                res.status(200).json({ message: 'Đã báo lỗi và gửi về cho Logistics!' });
            }
        );
    });
};
// 8. Xuất kho: Đổi từ 'completed' sang 'shipping' (Đang giao)
const exportOrder = (req, res) => {
    const orderId = req.params.id;
    const { warehouse_id } = req.body;

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        // ... (giữ nguyên đoạn INSERT stock_outbound_notes và SELECT items)
        // Chỉ sửa dòng Update status dưới đây:
        db.run(
            `UPDATE sales_orders SET status = 'shipping', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, 
            [orderId], 
            function (err) {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ message: 'Lỗi chốt đơn' }); }
                db.run("COMMIT");
                res.status(200).json({ message: 'Đã xuất kho, đơn hàng chuyển sang trạng thái Đang giao!' });
            }
        );
    });
};

// 9. HÀM MỚI: Xác nhận đã giao hàng thành công (Logistics bấm)
const confirmDelivery = (req, res) => {
    const orderId = req.params.id;
    db.run(
        `UPDATE sales_orders SET status = 'completed', actual_delivery_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [orderId],
        function(err) {
            if (err) return res.status(500).json({ message: 'Lỗi xác nhận giao hàng' });
            res.status(200).json({ message: 'Xác nhận đơn hàng đã giao thành công!' });
        }
    );
};

// 10. HÀM HỦY ĐƠN: XỬ LÝ CẢ TRƯỜNG HỢP "BOM HÀNG" LẪN "BỊ TỪ CHỐI/HỦY SỚM"
const returnInventory = (req, res) => {
    const orderId = req.params.id;

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        // BƯỚC 1: Tìm xem đơn này ĐÃ TỪNG XUẤT KHO CHƯA (Có nằm trong bảng phiếu xuất không?)
        db.get(
            `SELECT warehouse_id FROM stock_outbound_notes WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
            [orderId],
            (err, outbound) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ message: 'Lỗi kiểm tra lịch sử xuất kho' });
                }

                if (outbound) {
                    // ==============================================================
                    // TRƯỜNG HỢP 1: ĐÃ XUẤT KHO (BOM HÀNG) -> PHẢI HOÀN KHO
                    // ==============================================================
                    const oldWarehouseId = outbound.warehouse_id;

                    db.all(`SELECT product_id, quantity FROM sales_order_items WHERE order_id = ?`, [orderId], (err, items) => {
                        if (err || !items || items.length === 0) {
                            db.run("ROLLBACK");
                            return res.status(400).json({ message: 'Lỗi lấy dữ liệu sản phẩm để hoàn kho' });
                        }

                        let completedItems = 0;
                        let hasError = false;

                        items.forEach(item => {
                            db.run(
                                `UPDATE inventory_balances SET on_hand_qty = IFNULL(on_hand_qty, 0) + ? 
                                 WHERE product_id = ? AND warehouse_id = ?`,
                                [item.quantity, item.product_id, oldWarehouseId],
                                function (err) {
                                    if (err) hasError = true;

                                    completedItems++;
                                    if (completedItems === items.length) {
                                        if (hasError) {
                                            db.run("ROLLBACK");
                                            return res.status(500).json({ message: 'Lỗi khi cộng trả số lượng vào kho' });
                                        } 
                                        
                                        // Đồng bộ trạng thái đơn sau khi hoàn kho là 'canceled' để frontend hiển thị đúng là hủy đơn
                                        db.run(
                                            `UPDATE sales_orders SET status = 'canceled', actual_delivery_date = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                            [orderId],
                                            function (err) {
                                                if (err) { db.run("ROLLBACK"); return res.status(500).json({ message: 'Lỗi đổi trạng thái' }); }
                                                db.run("COMMIT");
                                                res.status(200).json({ message: `Bom hàng: Đã hoàn trả tồn kho về Kho ID ${oldWarehouseId} và cập nhật trạng thái hủy đơn!` });
                                            }
                                        );
                                    }
                                }
                            );
                        });
                    });

                } else {
                    // ==============================================================
                    // TRƯỜNG HỢP 2: CHƯA XUẤT KHO (LOGISTICS TỪ CHỐI HOẶC SALE HỦY)
                    // ==============================================================
                    // Kho chưa bị trừ hàng, nên CHỈ CẦN đổi trạng thái đơn thành Hủy là xong!
                    
                    // Đồng bộ trạng thái hoàn trả/bom hàng là 'returned' để LogisticsPage hiển thị đúng
                    db.run(
                        `UPDATE sales_orders SET status = 'returned', actual_delivery_date = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [orderId],
                        function (err) {
                            if (err) {
                                db.run("ROLLBACK");
                                return res.status(500).json({ message: 'Lỗi đổi trạng thái đơn' });
                            }
                            db.run("COMMIT");
                            res.status(200).json({ message: 'Đã cập nhật đơn thành trạng thái hoàn trả/từ chối.' });
                        }
                    );
                }
            }
        );
    });
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