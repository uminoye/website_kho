const pool = require('../config/database');

// ==========================================================
// 1. LẤY DANH SÁCH SẢN PHẨM & GỘP TỒN KHO TỪ NHIỀU KHO
// ==========================================================
const getAllProducts = async (req, res) => {
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
                SELECT STRING_AGG(w.name || ': ' || COALESCE(ib2.on_hand_qty, 0), ' | ')
                FROM warehouses w
                LEFT JOIN inventory_balances ib2 ON w.id = ib2.warehouse_id AND ib2.product_id = p.id
            ) as stock_breakdown
        FROM products p
        LEFT JOIN inventory_balances ib ON p.id = ib.product_id
        GROUP BY p.id
        ORDER BY p.id DESC
    `;
    
    try {
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Lỗi Database', error: err.message });
    }
};

const createProduct = async (req, res) => {
    const { sku, name, sale_price, unit, category, image_url, min_stock, warehouse_id, initial_stock } = req.body;

    if (!sku || !name || !sale_price) {
        return res.status(400).json({ message: 'Vui lòng nhập đầy đủ SKU, Tên và Giá' });
    }

    const query = `INSERT INTO products (sku, name, sale_price, unit, category, image_url, min_stock) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
    
    try {
        const { rows } = await pool.query(query, [sku, name, sale_price, unit || 'cái', category || null, image_url || null, parseInt(min_stock, 10) || 50]);
        const productId = rows[0].id;
        const stockQty = parseInt(initial_stock, 10) || 0;

        if (stockQty > 0) {
            if (warehouse_id === 'all') {
                const wRows = await pool.query(`SELECT id FROM warehouses`);
                for (let row of wRows.rows) {
                    await pool.query(`INSERT INTO inventory_balances (warehouse_id, product_id, on_hand_qty) VALUES ($1, $2, $3)`, [row.id, productId, stockQty]);
                }
                return res.status(201).json({ message: 'Thêm SP và chia đều Tồn kho thành công!' });
            } else {
                await pool.query(`INSERT INTO inventory_balances (warehouse_id, product_id, on_hand_qty) VALUES ($1, $2, $3)`, [warehouse_id, productId, stockQty]);
                return res.status(201).json({ message: 'Thêm SP và lưu Tồn kho thành công!' });
            }
        } else {
            res.status(201).json({ message: 'Thêm sản phẩm thành công (Tồn kho 0)' });
        }
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ message: `Mã SKU "${sku}" đã tồn tại!` });
        }
        res.status(500).json({ message: 'Lỗi Database', error: err.message });
    }
};

const updateProduct = async (req, res) => {
    const { id } = req.params;
    const { sku, name, sale_price, unit, category, image_url, min_stock, adjust_stock, target_warehouse } = req.body;

    const query = `UPDATE products SET sku = $1, name = $2, sale_price = $3, unit = $4, category = $5, image_url = $6, min_stock = $7 WHERE id = $8`;
    try {
        await pool.query(query, [sku, name, sale_price, unit, category || null, image_url || null, parseInt(min_stock, 10) || 50, id]);

        if (adjust_stock !== undefined && adjust_stock !== '' && target_warehouse) {
            if (target_warehouse === 'all') {
                return res.status(400).json({ message: 'Muốn sửa tồn kho thì phải chọn đúng 1 kho cụ thể, không được chọn "Tất cả"!' });
            }

            const newQty = parseInt(adjust_stock, 10) || 0;
            const { rows } = await pool.query(`SELECT id FROM inventory_balances WHERE product_id = $1 AND warehouse_id = $2`, [id, target_warehouse]);
            
            if (rows.length > 0) {
                await pool.query(`UPDATE inventory_balances SET on_hand_qty = $1 WHERE product_id = $2 AND warehouse_id = $3`, [newQty, id, target_warehouse]);
            } else {
                await pool.query(`INSERT INTO inventory_balances (warehouse_id, product_id, on_hand_qty) VALUES ($1, $2, $3)`, [target_warehouse, id, newQty]);
            }
            return res.status(200).json({ message: 'Đã cập nhật SP và Điều chỉnh tồn kho thành công!' });
        } else {
            res.status(200).json({ message: 'Cập nhật thông tin sản phẩm thành công!' });
        }
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ message: `Mã SKU "${sku}" đã tồn tại!` });
        }
        res.status(500).json({ message: 'Lỗi Database khi cập nhật thông tin', error: err.message });
    }
};

const deleteProduct = async (req, res) => {
    const { id } = req.params;

    const checkQuery = `
        SELECT COALESCE(SUM(on_hand_qty), 0) AS total_stock
        FROM inventory_balances
        WHERE product_id = $1
    `;

    try {
        const { rows } = await pool.query(checkQuery, [id]);
        const totalStock = Number(rows[0]?.total_stock || 0);
        
        if (totalStock > 0) {
            return res.status(400).json({
                message: 'Không thể xóa sản phẩm vì vẫn còn tồn kho. Hãy xuất hết hàng trước khi xóa.',
            });
        }

        const deleteResult = await pool.query(`DELETE FROM products WHERE id = $1`, [id]);
        if (deleteResult.rowCount === 0) {
            return res.status(404).json({ message: 'Không tìm thấy sản phẩm cần xóa' });
        }
        return res.status(200).json({ message: 'Xóa sản phẩm thành công' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi khi xóa sản phẩm', error: err.message });
    }
};

module.exports = { getAllProducts, createProduct, updateProduct, deleteProduct };