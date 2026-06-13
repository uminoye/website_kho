const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    // Lấy token từ header của request gửi lên
    let token = req.headers['authorization'];
    if (!token) return res.status(403).json({ message: 'Không tìm thấy thẻ xác thực (Token)' });

    try {
        // Token thường có dạng "Bearer xyz...", ta cắt lấy phần "xyz..."
        const tokenBody = token.split(' ')[1];
        
        // Giải mã token bằng chìa khóa bí mật
        const decoded = jwt.verify(tokenBody, 'KHOA_BIMAT_CUA_DU_AN_XUAT_NHAP_TON');
        
        // Lưu lại thông tin user để các bước sau dùng tới
        req.userId = decoded.id;
        req.userRole = decoded.role_id;
        
        next(); // Cho phép đi tiếp
    } catch (error) {
        return res.status(401).json({ message: 'Token không hợp lệ hoặc đã hết hạn' });
    }
};

module.exports = { verifyToken };