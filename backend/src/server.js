const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./config/database'); 

// --- 1. KHAI BÁO CÁC ROUTES ---
const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/product.routes');
const customerRoutes = require('./routes/customer.routes');
const orderRoutes = require('./routes/order.routes');
const receiptRoutes = require('./routes/receipt.routes');
const logisticsRoutes = require('./routes/logistics.routes'); 
const outboundRoutes = require('./routes/outbound.routes');
const reportRoutes = require('./routes/report.routes');
const warehouseRoutes = require('./routes/warehouse.routes');
const uploadRoutes = require('./routes/upload.routes');

const app = express();

// --- 2. CẤU HÌNH MIDDLEWARE ---
app.use(cors()); 
app.use(express.json()); 

// --- 3. SERVE STATIC FILES ---
app.use('/uploads', express.static(path.resolve(__dirname, '../../uploads')));
app.use(express.static(path.resolve(__dirname, '../dist')));

// --- 4. ĐƯỜNG DẪN KIỂM TRA (TEST) ---
app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'Server Backend đã hoạt động!',
        database: 'Kết nối Database SQLite thành công.' 
    });
});

// --- 5. ĐĂNG KÝ CÁC ROUTES VỚI EXPRESS ---
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);   
app.use('/api/customers', customerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/receipts', receiptRoutes);  
app.use('/api/logistics', logisticsRoutes);
app.use('/api/outbounds', outboundRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/warehouses', warehouseRoutes);
app.use('/api/uploads', uploadRoutes);

// --- 6. SPA FALLBACK - Trả về index.html cho các route không phải API ---
app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../dist/index.html'));
});

// --- 7. XỬ LÝ LỖI (ERROR HANDLING) ---
app.use((err, req, res, next) => {
    console.error("🔥 LỖI HỆ THỐNG:", err.stack);
    res.status(500).json({ message: 'Đã có lỗi xảy ra trên server!', error: err.message });
});

// --- 8. KHỞI CHẠY SERVER ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
    console.log(`📂 API Test: http://localhost:${PORT}/api/test`);
});
