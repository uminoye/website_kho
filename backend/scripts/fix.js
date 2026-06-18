const pool = require('../src/config/database');
const bcrypt = require('bcryptjs');

const fixPasswords = async () => {
    // Nhờ thư viện tạo mã băm THẬT cho chữ '123456'
    const realHash = bcrypt.hashSync('123456', 10);

    try {
        // Cập nhật mã băm thật này cho tất cả user trong database PostgreSQL
        await pool.query('UPDATE users SET password_hash = $1', [realHash]);
        console.log("✅ Đã cập nhật mật khẩu 123456 chuẩn cho tất cả tài khoản trên PostgreSQL!");
        console.log("Bạn có thể quay lại giao diện web để đăng nhập rồi nhé.");
        process.exit(0);
    } catch (err) {
        console.log("Lỗi:", err.message);
        process.exit(1);
    }
};

fixPasswords();