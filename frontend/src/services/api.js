import axios from 'axios';

// Kết nối với Backend trên Render
const api = axios.create({
  baseURL: 'https://website-kho.onrender.com/api', 
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
      // Sửa lại thành window.location.hash để tương thích với HashRouter trên GitHub Pages
      window.location.hash = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;