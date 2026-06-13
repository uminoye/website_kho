const db = require('../config/database');

// ==========================================================
// 1. LẤY DANH SÁCH SẢN PHẨM & GỘP TỒN KHO TỪ NHIỀU KHO
// ==========================================================
const getAllProducts = (req, res) => {
    const query = `
        SELECT 
            p.*,
            COALESCE(p.min_stock, 50) as min_stock,
            COALESCE(SUM(ib.on_hand_qty), 0) as total_stock,
            CASE
                WHEN COALESCE(SUM(ib.on_hand_qty), 0) = 0 THEN 'Hết hàng'
                WHEN COALESCE(SUM(ib.on_hand_qty), 0) < COALESCE(p.min_stock, 50) THEN 'Sắp hết hàng'
                ELSE 'Còn hàng'
            END as stock_status,
            (
                SELECT GROUP_CONCAT(w.name || ': ' || COALESCE(ib2.on_hand_qty, 0), ' | ')
                FROM warehouses w
                LEFT JOIN inventory_balances ib2 ON w.id = ib2.warehouse_id AND ib2.product_id = p.id
            ) as stock_breakdown
        FROM products p
        LEFT JOIN inventory_balances ib ON p.id = ib.product_id
        GROUP BY p.id
        ORDER BY p.id DESC
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi Database', error: err.message });
        res.status(200).json(rows);
    });
};

const createProduct = (req, res) => {
    const { sku, name, sale_price, unit, category, image_url, min_stock, warehouse_id, initial_stock } = req.body;

    if (!sku || !name || !sale_price) {
        return res.status(400).json({ message: 'Vui lòng nhập đầy đủ SKU, Tên và Giá' });
    }

    const query = `INSERT INTO products (sku, name, sale_price, unit, category, image_url, min_stock) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    
    db.run(query, [sku, name, sale_price, unit || 'cái', category || null, image_url || null, parseInt(min_stock, 10) || 50], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ message: `Mã SKU "${sku}" đã tồn tại!` });
            }
            return res.status(500).json({ message: 'Lỗi Database' });
        }

        const productId = this.lastID;
        const stockQty = parseInt(initial_stock, 10) || 0;

        if (stockQty > 0) {
            if (warehouse_id === 'all') {
                db.all(`SELECT id FROM warehouses`, [], (err, rows) => {
                    if (!err && rows) {
                        rows.forEach(row => {
                            db.run(`INSERT INTO inventory_balances (warehouse_id, product_id, on_hand_qty) VALUES (?, ?, ?)`, 
                            [row.id, productId, stockQty]);
                        });
                    }
                    return res.status(201).json({ message: 'Thêm SP và chia đều Tồn kho thành công!' });
                });
            } else {
                db.run(`INSERT INTO inventory_balances (warehouse_id, product_id, on_hand_qty) VALUES (?, ?, ?)`, 
                [warehouse_id, productId, stockQty], () => {
                    return res.status(201).json({ message: 'Thêm SP và lưu Tồn kho thành công!' });
                });
            }
        } else {
            res.status(201).json({ message: 'Thêm sản phẩm thành công (Tồn kho 0)' });
        }
    });
};

const updateProduct = (req, res) => {
    const { id } = req.params;
    const { sku, name, sale_price, unit, category, image_url, min_stock, adjust_stock, target_warehouse } = req.body;

    const query = `UPDATE products SET sku = ?, name = ?, sale_price = ?, unit = ?, category = ?, image_url = ?, min_stock = ? WHERE id = ?`;
    db.run(query, [sku, name, sale_price, unit, category || null, image_url || null, parseInt(min_stock, 10) || 50, id], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ message: `Mã SKU "${sku}" đã tồn tại!` });
            }
            return res.status(500).json({ message: 'Lỗi Database khi cập nhật thông tin' });
        }

        if (adjust_stock !== undefined && adjust_stock !== '' && target_warehouse) {
            if (target_warehouse === 'all') {
                return res.status(400).json({ message: 'Muốn sửa tồn kho thì phải chọn đúng 1 kho cụ thể, không được chọn "Tất cả"!' });
            }

            const newQty = parseInt(adjust_stock, 10) || 0;
            db.get(`SELECT id FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?`, [id, target_warehouse], (err, row) => {
                if (row) {
                    db.run(`UPDATE inventory_balances SET on_hand_qty = ? WHERE product_id = ? AND warehouse_id = ?`, [newQty, id, target_warehouse]);
                } else {
                    db.run(`INSERT INTO inventory_balances (warehouse_id, product_id, on_hand_qty) VALUES (?, ?, ?)`, [target_warehouse, id, newQty]);
                }
                return res.status(200).json({ message: 'Đã cập nhật SP và Điều chỉnh tồn kho thành công!' });
            });
        } else {
            res.status(200).json({ message: 'Cập nhật thông tin sản phẩm thành công!' });
        }
    });
};

const deleteProduct = (req, res) => {
    const { id } = req.params;

    const checkQuery = `
        SELECT COALESCE(SUM(on_hand_qty), 0) AS total_stock
        FROM inventory_balances
        WHERE product_id = ?
    `;

    db.get(checkQuery, [id], (err, row) => {
        if (err) {
            return res.status(500).json({ message: 'Lỗi khi kiểm tra tồn kho của sản phẩm', error: err.message });
        }

        const totalStock = Number(row?.total_stock || 0);
        if (totalStock > 0) {
            return res.status(400).json({
                message: 'Không thể xóa sản phẩm vì vẫn còn tồn kho. Hãy xuất hết hàng trước khi xóa.',
            });
        }

        db.run(`DELETE FROM products WHERE id = ?`, [id], function(deleteErr) {
            if (deleteErr) {
                return res.status(500).json({ message: 'Lỗi khi xóa sản phẩm', error: deleteErr.message });
            }

            if (this.changes === 0) {
                return res.status(404).json({ message: 'Không tìm thấy sản phẩm cần xóa' });
            }

            return res.status(200).json({ message: 'Xóa sản phẩm thành công' });
        });
    });
};

module.exports = { getAllProducts, createProduct, updateProduct, deleteProduct };