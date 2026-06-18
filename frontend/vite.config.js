import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Quan trọng: Thay 'ten-repository-cua-ban' bằng đúng tên thư mục chứa code trên GitHub
  base: '/inventory-management/', 
})
