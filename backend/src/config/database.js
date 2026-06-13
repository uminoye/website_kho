const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Xác định đường dẫn tới thư mục database bên ngoài
const dbPath = path.resolve(__dirname, '../../../database/inventory.sqlite');
const schemaPath = path.resolve(__dirname, '../../../database/schema.sql');
const seedPath = path.resolve(__dirname, '../../../database/seed.sql');
const migrationsDir = path.resolve(__dirname, '../../../database/migrations');

// Kiểm tra xem file database.sqlite đã tồn tại chưa
const dbExists = fs.existsSync(dbPath);

// Khởi tạo kết nối (nếu file chưa có, SQLite sẽ tự tạo ra file trống)
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Lỗi kết nối database:', err.message);
    } else {
        console.log('Đã kết nối thành công tới cơ sở dữ liệu SQLite.');
    }
});

// Hàm đọc và chạy file SQL
const runSQLFile = (filePath) => {
    if (!fs.existsSync(filePath)) {
        console.error(`Không tìm thấy file: ${filePath}`);
        return;
    }
    const sql = fs.readFileSync(filePath, 'utf8');
    db.exec(sql, (err) => {
        if (err) {
            console.error(`Lỗi khi chạy file ${filePath}:`, err.message);
        } else {
            console.log(`Đã chạy thành công cấu trúc từ file: ${path.basename(filePath)}`);
        }
    });
};

const runProductColumnMigrations = () => {
    db.all(`PRAGMA table_info(products)`, [], (err, columns) => {
        if (err) {
            console.error('Lỗi kiểm tra cấu trúc bảng products:', err.message);
            return;
        }

        const columnNames = new Set(columns.map((column) => column.name));
        const pendingStatements = [];

        if (!columnNames.has('category')) {
            pendingStatements.push('ALTER TABLE products ADD COLUMN category VARCHAR(100);');
        }

        if (!columnNames.has('image_url')) {
            pendingStatements.push('ALTER TABLE products ADD COLUMN image_url TEXT;');
        }

        if (!columnNames.has('min_stock')) {
            pendingStatements.push('ALTER TABLE products ADD COLUMN min_stock INTEGER DEFAULT 50;');
        }

        if (pendingStatements.length === 0) {
            db.run(`UPDATE products SET min_stock = 50 WHERE min_stock IS NULL OR min_stock = ''`);
            return;
        }

        db.exec(pendingStatements.join('\n'), (migrationErr) => {
            if (migrationErr) {
                console.error('Lỗi khi nâng cấp bảng products:', migrationErr.message);
                return;
            }

            db.run(`UPDATE products SET min_stock = 50 WHERE min_stock IS NULL OR min_stock = ''`);
            console.log('Đã cập nhật an toàn cấu trúc bảng products.');
        });
    });
};

// Nếu chưa có database, hệ thống sẽ tự động chạy schema và nạp seed data
if (!dbExists) {
    console.log('Phát hiện lần chạy đầu tiên. Đang tự động tạo bảng và nạp dữ liệu mẫu...');
    db.serialize(() => {
        runSQLFile(schemaPath);
        runSQLFile(seedPath);
    });
} else {
    runProductColumnMigrations();
}

module.exports = db;