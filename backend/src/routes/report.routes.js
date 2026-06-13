const express = require('express');
const router = express.Router();
const reportController = require('../controllers/report.controller');

// Nối với hàm Dashboard cũ của bà
router.get('/dashboard', reportController.getDashboardStats); 

// Nối với hàm xuất file Excel mới thêm
router.get('/inventory', reportController.getInventoryReport); 

module.exports = router;