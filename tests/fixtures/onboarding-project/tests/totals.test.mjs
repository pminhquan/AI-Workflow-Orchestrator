import test from 'node:test';
import assert from 'node:assert/strict';
import {totalCents} from '../src/totals.mjs';
test('empty cart totals zero',()=>assert.equal(totalCents([]),0));
test('cart sums quantities in cents',()=>assert.equal(totalCents([{priceCents:799,quantity:2},{priceCents:150,quantity:3}]),2048));
