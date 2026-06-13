import axios from 'axios';

// Kết nối với cổng 5000 của Backend
const api = axios.create({
  baseURL: 'http://localhost:5000/api', 
});

// Tự động gắn thẻ Token vào mỗi lần gọi API nếu đã đăng nhập
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Tự động văng ra trang Login nếu Token hết hạn (Lỗi 401)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;