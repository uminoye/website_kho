const db = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 1. ĐĂNG NHẬP (Giữ nguyên của bà vì nó chuẩn rồi)
const login = (req, res) => {
    const { email, password } = req.body;

    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err) return res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
        if (!user) return res.status(404).json({ message: 'Tài khoản không tồn tại' });

        const passwordIsValid = bcrypt.compareSync(password, user.password_hash);
        if (!passwordIsValid) return res.status(401).json({ message: 'Sai mật khẩu' });

        const token = jwt.sign(
            { id: user.id, role_id: user.role_id },
            'KHOA_BIMAT_CUA_DU_AN_XUAT_NHAP_TON',
            { expiresIn: 86400 } // 24 giờ
        );

        res.status(200).json({
            message: 'Đăng nhập thành công',
            user: {
                id: user.id,
                full_name: user.full_name,
                email: user.email, // Trả về email
                role_id: user.role_id
            },
            accessToken: token
        });
    });
};

// 2. LẤY DANH SÁCH (Sửa lại tìm kiếm theo cột email)
const getAllUsers = (req, res) => {
    const query = `SELECT id, email, full_name, role_id FROM users ORDER BY id DESC`;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi Database: ' + err.message });
        res.status(200).json(rows);
    });
};

// 3. TẠO TÀI KHOẢN (Mã hóa mật khẩu & Dùng email)
const createUser = (req, res) => {
    const { email, password, full_name, role_id } = req.body;
    if (!email || !password || !full_name) return res.status(400).json({ message: 'Vui lòng nhập đủ thông tin!' });

    // CỰC KỲ QUAN TRỌNG: Phải mã hóa password thì hàm Login mới hiểu được
    const hashed_password = bcrypt.hashSync(password, 10);

    const query = `INSERT INTO users (email, password_hash, full_name, role_id) VALUES (?, ?, ?, ?)`;
    db.run(query, [email, hashed_password, full_name, role_id || 2], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ message: 'Email này đã được sử dụng!' });
            return res.status(500).json({ message: 'Lỗi khi tạo tài khoản' });
        }
        res.status(201).json({ message: 'Tạo tài khoản thành công!' });
    });
};

// 4. SỬA TÀI KHOẢN
const updateUser = (req, res) => {
    const { id } = req.params;
    const { full_name, role_id, password } = req.body;

    let query = `UPDATE users SET full_name = ?, role_id = ?`;
    let params = [full_name, role_id];

    // Nếu Admin nhập pass mới -> Mã hóa pass mới đó rồi lưu vào cột password_hash
    if (password) {
        query += `, password_hash = ?`;
        params.push(bcrypt.hashSync(password, 10)); 
    }
    
    query += ` WHERE id = ?`;
    params.push(id);

    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ message: 'Lỗi khi cập nhật tài khoản' });
        res.status(200).json({ message: 'Cập nhật thành công!' });
    });
};

// 5. XÓA TÀI KHOẢN
const deleteUser = (req, res) => {
    const { id } = req.params;
    db.get(`SELECT role_id FROM users WHERE id = ?`, [id], (err, user) => {
        if (user && user.role_id === 1) {
            return res.status(400).json({ message: 'Tuyệt đối không được xóa tài khoản Admin gốc!' });
        }
        db.run(`DELETE FROM users WHERE id = ?`, [id], function(err) {
            if (err) return res.status(500).json({ message: 'Lỗi khi xóa tài khoản' });
            res.status(200).json({ message: 'Đã xóa tài khoản nhân viên!' });
        });
    });
};

module.exports = { login, getAllUsers, createUser, updateUser, deleteUser };