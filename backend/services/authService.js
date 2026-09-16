const crypto = require('crypto');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}
function token(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function slugify(value) { return String(value||'workspace').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80) || 'workspace'; }
function publicUser(row) { return { id: row.id, name: row.name, email: row.email, role: row.role, platform_role: row.platform_role || 'user', workspace_id: row.workspace_id, workspace_name: row.workspace_name || null }; }
module.exports = { hashPassword, verifyPassword, token, slugify, publicUser };
