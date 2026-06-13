const db = require('../config/database');

const getAllWarehouses = (req, res) => {
    db.all(`SELECT * FROM warehouses ORDER BY id ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi lấy danh sách kho' });
        res.status(200).json(rows);
    });
};

const createWarehouse = (req, res) => {
    const { name, location } = req.body;
    if (!name) return res.status(400).json({ message: 'Tên kho không được để trống' });

    db.run(`INSERT INTO warehouses (name, location) VALUES (?, ?)`, [name, location], function(err) {
        if (err) return res.status(500).json({ message: 'Lỗi khi thêm kho mới' });
        res.status(201).json({ id: this.lastID, name, location });
    });
};
const deleteWarehouse = (req, res) => {
    const { id } = req.params;

    // 1. Kiểm tra xem thực sự có hàng (số lượng > 0) không
    db.get(`SELECT SUM(on_hand_qty) as total FROM inventory_balances WHERE warehouse_id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ message: 'Lỗi kiểm tra tồn kho' });

        if (row && row.total > 0) {
            return res.status(400).json({ message: `Kho còn ${row.total} món hàng, bà không được xóa đâu, đền chết! =))` });
        }

        // 2. Nếu hàng bằng 0, mình tiến hành "dọn rác" và xóa kho
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");

            // Xóa các bản ghi tồn kho bằng 0 để tránh lỗi ràng buộc
            db.run(`DELETE FROM inventory_balances WHERE warehouse_id = ?`, [id]);

            // Xóa chính cái kho đó
            db.run(`DELETE FROM warehouses WHERE id = ?`, [id], function(err) {
                if (err) {
                    db.run("ROLLBACK");
                    // Lỗi này thường do kho đã có trong Phiếu Nhập/Xuất cũ
                    return res.status(500).json({ 
                        message: 'Kho này đã có lịch sử giao dịch (Phiếu nhập/xuất), không nên xóa để bảo vệ dữ liệu!' 
                    });
                }
                db.run("COMMIT");
                res.status(200).json({ message: 'Đã xóa kho thành công!' });
            });
        });
    });
};

module.exports = { getAllWarehouses, createWarehouse, deleteWarehouse };