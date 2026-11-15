#!/usr/bin/env bash
# src/ 下两个小模块（购物车与登录），还没有任何规格。
source "$(dirname "$0")/../fixtures.sh"
eval_init
mkdir -p src
cat >src/cart.js <<'JS'
const items = [];

function addItem(name, priceCents) {
  items.push({ name, priceCents });
}

function totalCents() {
  return items.reduce((sum, item) => sum + item.priceCents, 0);
}

module.exports = { addItem, totalCents };
JS
cat >src/auth.js <<'JS'
const sessions = new Set();

function login(user, password) {
  if (password.length < 8) throw new Error('password too short');
  sessions.add(user);
}

function logout(user) {
  sessions.delete(user);
}

module.exports = { login, logout };
JS
