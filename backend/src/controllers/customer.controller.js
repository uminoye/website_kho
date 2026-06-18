const pool = require('../config/database');

// Lấy danh sách tất cả khách hàng
const getAllCustomers = async (req, res) => {
    // JOIN với bảng users để biết ai là người tạo khách hàng này
    const query = `
        SELECT c.*, u.full_name as creator_name 
        FROM customers c 
        LEFT JOIN users u ON c.created_by = u.id 
        ORDER BY c.id DESC
    `;
    try {
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
    }
};

// Tạo khách hàng mới (Dành cho Sales)
const createCustomer = async (req, res) => {
    const { customer_code, company_name, phone, address, contact_person } = req.body;
    const created_by = req.userId; // Lấy ID của Sales đang đăng nhập từ Token

    try {
        const { rows } = await pool.query(
            `INSERT INTO customers (customer_code, company_name, phone, address, contact_person, created_by) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [customer_code, company_name, phone, address, contact_person, created_by]
        );
        res.status(201).json({ message: 'Tạo khách hàng thành công', id: rows[0].id });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ message: 'Lỗi tạo khách hàng (Trùng mã KH)' });
        res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
    }
};

const deleteCustomer = async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query(`DELETE FROM customers WHERE id = $1`, [id]);
        res.status(200).json({ message: 'Đã xóa khách hàng' });
    } catch (err) {
        res.status(500).json({ message: 'Không thể xóa khách hàng này', error: err.message });
    }
};

module.exports = { getAllCustomers, createCustomer, deleteCustomer };