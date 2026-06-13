const express = require('express');
const router = express.Router();
const receiptController = require('../controllers/receipt.controller');

router.get('/', receiptController.getAllReceipts);
router.post('/', receiptController.createRequest);
router.put('/:id/respond', receiptController.factoryRespond); // NM phản hồi
router.put('/:id/confirm', receiptController.confirmReceipt); // Kho nhận hàng

module.exports = router;