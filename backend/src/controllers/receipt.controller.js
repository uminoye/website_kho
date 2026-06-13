const db = require('../config/database');

// 1. LẤY DANH SÁCH PHIẾU
const getAllReceipts = (req, res) => {
    const query = `
        SELECT p.*, w.name as warehouse_name, u.full_name as creator_name
        FROM production_receipts p
        LEFT JOIN warehouses w ON p.warehouse_id = w.id
        LEFT JOIN users u ON p.created_by = u.id
        ORDER BY p.id DESC
    `;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });

        if (!rows.length) {
            return res.status(200).json([]);
        }

        const receiptIds = rows.map((row) => row.id);
        const placeholders = receiptIds.map(() => '?').join(',');

        db.all(
            `
                SELECT pri.receipt_id, pri.product_id, pri.quantity, p.name as product_name
                FROM production_receipt_items pri
                LEFT JOIN products p ON p.id = pri.product_id
                WHERE pri.receipt_id IN (${placeholders})
                ORDER BY pri.id ASC
            `,
            receiptIds,
            (itemErr, items) => {
                if (itemErr) return res.status(500).json({ message: 'Lỗi máy chủ', error: itemErr.message });

                const itemsByReceipt = items.reduce((acc, item) => {
                    if (!acc[item.receipt_id]) acc[item.receipt_id] = [];
                    acc[item.receipt_id].push(item);
                    return acc;
                }, {});

                const result = rows.map((row) => ({
                    ...row,
                    items: itemsByReceipt[row.id] || []
                }));

                return res.status(200).json(result);
            }
        );
    });
};

// 2. KHO TẠO YÊU CẦU (Status: PENDING)
const createRequest = (req, res) => {
    const { receipt_no, warehouse_id, receipt_date, note, items } = req.body;
    const created_by = req.user?.id || 1; 

    if (!items || items.length === 0) return res.status(400).json({ message: 'Phải có sản phẩm!' });

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(
            `INSERT INTO production_receipts (receipt_no, warehouse_id, receipt_date, created_by, note, status) VALUES (?, ?, ?, ?, ?, 'PENDING')`,
            [receipt_no, warehouse_id, receipt_date, created_by, note],
            function (err) {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(400).json({ message: 'Lỗi tạo phiếu (Mã trùng)', error: err.message });
                }
                const receiptId = this.lastID;
                let completed = 0, hasError = false;

                items.forEach((item) => {
                    if (hasError) return;
                    db.run(`INSERT INTO production_receipt_items (receipt_id, product_id, quantity) VALUES (?, ?, ?)`,
                        [receiptId, item.product_id, item.quantity], (err) => {
                            if (err) hasError = true;
                            completed++;
                            if (completed === items.length) {
                                if (hasError) { db.run("ROLLBACK"); return res.status(500).json({ message: 'Lỗi chi tiết' }); }
                                db.run("COMMIT");
                                return res.status(201).json({ message: 'Đã gửi yêu cầu cho Nhà máy!' });
                            }
                        }
                    );
                });
            }
        );
    });
};

// 3. NHÀ MÁY PHẢN HỒI (Status: PROCESSING hoặc REJECTED)
const factoryRespond = (req, res) => {
    const receiptId = req.params.id;
    const { action, expected_date, reason } = req.body; // action: 'accept' hoặc 'reject'
    const respondentName = req.user?.full_name || req.user?.name || null;

    if (!receiptId) {
        return res.status(400).json({ message: 'Thiếu mã phiếu cần xử lý.' });
    }

    if (!['accept', 'reject'].includes(action)) {
        return res.status(400).json({ message: 'Hành động không hợp lệ. Chỉ chấp nhận accept hoặc reject.' });
    }

    if (action === 'accept' && !expected_date) {
        return res.status(400).json({ message: 'Vui lòng chọn ngày giao dự kiến trước khi duyệt.' });
    }

    db.get(`SELECT status, note FROM production_receipts WHERE id = ?`, [receiptId], (err, receipt) => {
        if (err) {
            console.error('[receipt.factoryRespond] SELECT failed', {
                receiptId,
                action,
                expected_date,
                reason,
                error: err.message,
            });
            return res.status(500).json({
                message: 'Lỗi máy chủ khi kiểm tra phiếu.',
                error: err.message,
                debug: {
                    step: 'select_receipt',
                    receiptId,
                },
            });
        }

        if (!receipt) {
            console.warn('[receipt.factoryRespond] receipt not found', { receiptId, action, expected_date, reason });
            return res.status(404).json({ message: 'Không tìm thấy phiếu cần xử lý.' });
        }

        if (receipt.status !== 'PENDING') {
            console.warn('[receipt.factoryRespond] invalid receipt status', {
                receiptId,
                currentStatus: receipt.status,
                action,
                expected_date,
                reason,
            });
            return res.status(400).json({ message: `Phiếu hiện đang ở trạng thái ${receipt.status}, không thể duyệt.` });
        }

        let newStatus = action === 'accept' ? 'PROCESSING' : 'REJECTED';
        let finalNote = `[NM Phản hồi]: ${reason || 'Không có lý do'} | Cũ: ${receipt.note || ''}`;
        const updateSql = `UPDATE production_receipts SET status = ?, receipt_date = ?, note = ?, responded_by = ?, responded_reason = ?, expected_delivery_date = ? WHERE id = ?`;
        const updateParams = [newStatus, expected_date || null, finalNote, respondentName, reason || null, expected_date || null, receiptId];

        console.info('[receipt.factoryRespond] executing update', {
            receiptId,
            action,
            expected_date,
            reason,
            respondentName,
            newStatus,
            sql: updateSql,
            params: updateParams,
        });

        db.run(
            updateSql,
            updateParams,
            (updateErr) => {
                if (updateErr) {
                    console.error('[receipt.factoryRespond] UPDATE failed', {
                        receiptId,
                        action,
                        expected_date,
                        reason,
                        respondentName,
                        sql: updateSql,
                        params: updateParams,
                        error: updateErr.message,
                    });
                    return res.status(500).json({
                        message: 'Lỗi cập nhật phiếu duyệt.',
                        error: updateErr.message,
                        debug: {
                            step: 'update_receipt',
                            receiptId,
                            sql: updateSql,
                            params: updateParams,
                        },
                    });
                }
                return res.status(200).json({
                    message: action === 'accept' ? 'Đã duyệt phiếu và hẹn ngày giao hàng!' : 'Đã từ chối yêu cầu nhập kho!',
                    debug: {
                        receiptId,
                        action,
                        newStatus,
                    },
                });
            }
        );
    });
};

// 4. KHO XÁC NHẬN ĐÃ NHẬN HÀNG (Status: COMPLETED -> CỘNG TỒN)
const confirmReceipt = (req, res) => {
    const receiptId = req.params.id;

    db.get(`SELECT status, warehouse_id FROM production_receipts WHERE id = ?`, [receiptId], (err, receipt) => {
        if (!receipt || receipt.status !== 'PROCESSING') return res.status(400).json({ message: 'Nhà máy chưa giao hoặc phiếu đã chốt!' });

        const wId = receipt.warehouse_id;

        db.all(`SELECT product_id, quantity FROM production_receipt_items WHERE receipt_id = ?`, [receiptId], (err, items) => {
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                let completed = 0, hasError = false;

                items.forEach((item) => {
                    if (hasError) return;
                    
                    db.run(`UPDATE products SET stock = stock + ? WHERE id = ?`, [item.quantity, item.product_id]);
                    db.get(`SELECT id FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?`, [item.product_id, wId], (err, bal) => {
                        if (bal) db.run(`UPDATE inventory_balances SET on_hand_qty = on_hand_qty + ? WHERE id = ?`, [item.quantity, bal.id]);
                        else db.run(`INSERT INTO inventory_balances (warehouse_id, product_id, on_hand_qty) VALUES (?, ?, ?)`, [wId, item.product_id, item.quantity]);

                        db.run(`INSERT INTO inventory_transactions (warehouse_id, product_id, transaction_type, quantity, reference_type, reference_id) VALUES (?, ?, 'IN', ?, 'production_receipt', ?)`,
                            [wId, item.product_id, item.quantity, receiptId], (err) => {
                                if (err) hasError = true;
                                completed++;
                                if (completed === items.length) {
                                    if (hasError) { db.run("ROLLBACK"); return res.status(500).json({ message: 'Lỗi cộng kho' }); }
                                    db.run(`UPDATE production_receipts SET status = 'COMPLETED' WHERE id = ?`, [receiptId], () => {
                                        db.run("COMMIT");
                                        return res.status(200).json({ message: 'Đã nhận hàng và cộng tồn kho!' });
                                    });
                                }
                            }
                        );
                    });
                });
            });
        });
    });
};

module.exports = { getAllReceipts, createRequest, factoryRespond, confirmReceipt };