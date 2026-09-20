import { roundCurrency, calculatePercentage, clamp } from '../utils/math.js';
import { findUserById } from './user-service.js';

let orderSequence = 1000;

export function processOrder({ userId, items, couponCode = null }) {
  const user = findUserById(userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  const subtotal = calculateSubtotal(items);
  const discount = couponCode ? applyDiscount(subtotal, couponCode) : 0;
  const taxableAmount = Math.max(0, subtotal - discount);
  const tax = calculateTax(taxableAmount, 18);
  const total = roundCurrency(taxableAmount + tax);

  return recordOrder({
    orderId: `ord_${++orderSequence}`,
    userId: user.id,
    itemCount: items.length,
    subtotal,
    discount,
    tax,
    total,
    timestamp: Date.now()
  });
}

export function calculateSubtotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += calculateLineItem(item);
  }
  return roundCurrency(sum);
}

export function calculateLineItem(item) {
  const qty = clamp(item.quantity || 1, 1, 999);
  const price = Math.max(0, item.price || 0);
  return roundCurrency(qty * price);
}

export function applyDiscount(amount, couponCode) {
  if (couponCode === 'SAVE20') {
    return calculatePercentage(amount, 20);
  }
  if (couponCode === 'FLAT10') {
    return Math.min(amount, 10.0);
  }
  return 0;
}

export function calculateTax(amount, taxRatePercent) {
  return calculatePercentage(amount, taxRatePercent);
}

export function recordOrder(orderData) {
  // Simulate database record creation
  return {
    ...orderData,
    status: 'CONFIRMED'
  };
}

export function refundOrder(orderId) {
  // Unused function to show untouched code reach
  return { orderId, status: 'REFUNDED' };
}
