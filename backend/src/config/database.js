const { Pool } = require('pg');

const connectionString = 'postgresql://neondb_owner:npg_AOfozxGDY82y@ep-late-haze-ao258m11.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString,
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error('Lỗi kết nối PostgreSQL (Neon):', err.stack);
  }
  console.log('Đã kết nối thành công tới cơ sở dữ liệu PostgreSQL (Neon).');
  release();
});

module.exports = pool;