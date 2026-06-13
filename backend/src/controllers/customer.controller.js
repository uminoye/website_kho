const db = require('../config/database');

// Lấy danh sách tất cả khách hàng
const getAllCustomers = (req, res) => {
    // JOIN với bảng users để biết ai là người tạo khách hàng này
    const query = `
        SELECT c.*, u.full_name as creator_name 
        FROM customers c 
        LEFT JOIN users u ON c.created_by = u.id 
        ORDER BY c.id DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
        res.status(200).json(rows);
    });
};

// Tạo khách hàng mới (Dành cho Sales)
const createCustomer = (req, res) => {
    const { customer_code, company_name, phone, address, contact_person } = req.body;
    const created_by = req.userId; // Lấy ID của Sales đang đăng nhập từ Token

    db.run(
        `INSERT INTO customers (customer_code, company_name, phone, address, contact_person, created_by) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [customer_code, company_name, phone, address, contact_person, created_by],
        function(err) {
            if (err) return res.status(400).json({ message: 'Lỗi tạo khách hàng (có thể trùng mã KH)', error: err.message });
            res.status(201).json({ message: 'Tạo khách hàng thành công', id: this.lastID });
        }
    );
};

const deleteCustomer = (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM customers WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ message: 'Không thể xóa khách hàng này', error: err.message });
        res.status(200).json({ message: 'Đã xóa khách hàng' });
    });
};

module.exports = { getAllCustomers, createCustomer, deleteCustomer };