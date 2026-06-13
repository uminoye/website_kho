const db = require('../config/database');

// Logistics xử lý đơn hàng (Chuyển xuống kho hoặc trả lại Sale)
const processOrder = (req, res) => {
    const { order_id, new_status, logistics_note } = req.body;
    const handled_by = req.user?.id || req.userId || null;

    if (!order_id || !new_status) {
        return res.status(400).json({ message: 'Thiếu order_id hoặc new_status' });
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // 1. Cập nhật trạng thái đơn hàng (VD: 'warehouse_processing' hoặc 'returned')
        db.run(
            `UPDATE sales_orders SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [new_status, logistics_note || null, order_id],
            function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
                }
                if (this.changes === 0) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
                }

                // 2. Lưu lịch sử làm việc của Logistics
                db.run(
                    `INSERT INTO delivery_requests (order_id, handled_by, received_at, status, logistics_note)
                     VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)`,
                    [order_id, handled_by, new_status, logistics_note || null],
                    (err2) => {
                        if (err2) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ message: 'Lỗi lưu lịch sử logistics', error: err2.message });
                        }

                        db.run('COMMIT');
                        return res.status(200).json({ message: 'Logistics đã xử lý đơn! Trạng thái mới: ' + new_status });
                    }
                );
            }
        );
    });
};

module.exports = { processOrder };