const pool = require('../config/database');

const getAllWarehouses = async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM warehouses ORDER BY id ASC`);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi lấy danh sách kho', error: err.message });
    }
};

const createWarehouse = async (req, res) => {
    const { name, location } = req.body;
    if (!name) return res.status(400).json({ message: 'Tên kho không được để trống' });

    try {
        const { rows } = await pool.query(
            `INSERT INTO warehouses (name, location) VALUES ($1, $2) RETURNING id`, 
            [name, location]
        );
        res.status(201).json({ id: rows[0].id, name, location });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi khi thêm kho mới', error: err.message });
    }
};

const deleteWarehouse = async (req, res) => {
    const { id } = req.params;

    try {
        const { rows } = await pool.query(`SELECT SUM(on_hand_qty) as total FROM inventory_balances WHERE warehouse_id = $1`, [id]);
        if (rows.length > 0 && rows[0].total > 0) {
            return res.status(400).json({ message: `Kho còn ${rows[0].total} món hàng, bà không được xóa đâu, đền chết! =))` });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`DELETE FROM inventory_balances WHERE warehouse_id = $1`, [id]);
            await client.query(`DELETE FROM warehouses WHERE id = $1`, [id]);
            await client.query("COMMIT");
            res.status(200).json({ message: 'Đã xóa kho thành công!' });
        } catch (err) {
            await client.query("ROLLBACK");
            return res.status(500).json({ message: 'Kho này đã có lịch sử giao dịch (Phiếu nhập/xuất), không nên xóa để bảo vệ dữ liệu!' });
        } finally {
            client.release();
        }
    } catch (err) {
        res.status(500).json({ message: 'Lỗi kiểm tra tồn kho', error: err.message });
    }
};

module.exports = { getAllWarehouses, createWarehouse, deleteWarehouse };