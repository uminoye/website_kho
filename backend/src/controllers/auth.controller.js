const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 1. ĐĂNG NHẬP
const login = async (req, res) => {
    const { email, password } = req.body;

    try {
        const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        const user = rows[0];
        
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
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
    }
};

// 2. LẤY DANH SÁCH
const getAllUsers = async (req, res) => {
    try {
        const query = `SELECT id, email, full_name, role_id FROM users ORDER BY id DESC`;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi Database: ' + err.message });
    }
};

// 3. TẠO TÀI KHOẢN
const createUser = async (req, res) => {
    const { email, password, full_name, role_id } = req.body;
    if (!email || !password || !full_name) return res.status(400).json({ message: 'Vui lòng nhập đủ thông tin!' });

    const hashed_password = bcrypt.hashSync(password, 10);

    const query = `INSERT INTO users (email, password_hash, full_name, role_id) VALUES ($1, $2, $3, $4)`;
    try {
        await pool.query(query, [email, hashed_password, full_name, role_id || 2]);
        res.status(201).json({ message: 'Tạo tài khoản thành công!' });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ message: 'Email này đã được sử dụng!' });
        res.status(500).json({ message: 'Lỗi khi tạo tài khoản' });
    }
};

// 4. SỬA TÀI KHOẢN
const updateUser = async (req, res) => {
    const { id } = req.params;
    const { full_name, role_id, password } = req.body;

    let query = `UPDATE users SET full_name = $1, role_id = $2`;
    let params = [full_name, role_id];
    let paramIndex = 3;

    if (password) {
        query += `, password_hash = $${paramIndex++}`;
        params.push(bcrypt.hashSync(password, 10)); 
    }
    
    query += ` WHERE id = $${paramIndex}`;
    params.push(id);

    try {
        await pool.query(query, params);
        res.status(200).json({ message: 'Cập nhật thành công!' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi khi cập nhật tài khoản' });
    }
};

// 5. XÓA TÀI KHOẢN
const deleteUser = async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query(`SELECT role_id FROM users WHERE id = $1`, [id]);
        const user = rows[0];
        if (user && user.role_id === 1) {
            return res.status(400).json({ message: 'Tuyệt đối không được xóa tài khoản Admin gốc!' });
        }
        
        await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
        res.status(200).json({ message: 'Đã xóa tài khoản nhân viên!' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi khi xóa tài khoản' });
    }
};

module.exports = { login, getAllUsers, createUser, updateUser, deleteUser };