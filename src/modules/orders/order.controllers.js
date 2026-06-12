import { Order } from './order.model.js';
import { Product } from '../products/product.model.js';
import { Cart } from '../carts/cart.model.js';
import { Coupon } from '../coupons/coupon.model.js';
import mongoose from 'mongoose';

function createValidationError(message) {
  const err = new Error(message);
  err.name = 'ValidationError';
  err.status = 400;
  return err;
}

//Admin
export const getAllOrders = async (req, res, next) => {
  try {
    const orders = await Order.find();
    return res.status(200).json({ success: true, data: orders });
  } catch (err) {
    // return res.status(400).json({ success: false, error: error });
    next(err);
  }
};

export const getOrderById = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: order
    });
  } catch (err) {
    next(err);
  }
};

export const createOrder = async (req, res, next) => {
  const SHIPPING_FEE = 50;
  const { status, total_amount: clientTotal, coupon_code } = req.body || {};

  if (!status || clientTotal === undefined) {
    return next(createValidationError('status and total_amount are required'));
  }

  // 1. Fetch cart from DB — do not trust order_item from frontend
  let cartItems;
  try {
    const cartDocs = await Cart.find({ user_id: req.user.users._id });
    cartItems = cartDocs.flatMap((doc) => doc.cart_item);
  } catch (err) {
    return next(err);
  }

  if (cartItems.length === 0) {
    return next(createValidationError('Cart is empty'));
  }

  // 2. Aggregate quantities per book_id
  const stockRequests = new Map();
  for (const item of cartItems) {
    const bookId = item.book_id.toString();
    stockRequests.set(bookId, (stockRequests.get(bookId) || 0) + Number(item.quantity));
  }

  // 3. Fetch products from DB for price + discount info
  let productMap;
  try {
    const bookIds = [...stockRequests.keys()];
    const products = await Product.find({ _id: { $in: bookIds } });

    if (products.length !== bookIds.length) {
      return next(createValidationError('One or more products not found'));
    }

    productMap = new Map(products.map((p) => [p._id.toString(), p]));
  } catch (err) {
    return next(err);
  }

  // 4. Build verified order items using DB data only
  const verifiedOrderItems = cartItems.map((item) => {
    const product = productMap.get(item.book_id.toString());
    return {
      book_id: product._id,
      book_name: product.book_name,
      author: product.author,
      quantity: Number(item.quantity),
      price: product.price,
      img_link: product.img_link,
      isDiscount: product.isDiscount,
      discountPercent: product.discountPercent
    };
  });

  // 5. Calculate subtotal + shipping server-side
  const subtotal = verifiedOrderItems.reduce((sum, item) => {
    const price = parseFloat(item.price.toString());
    const discount = item.isDiscount ? item.discountPercent : 0;
    return sum + price * (1 - discount / 100) * item.quantity;
  }, 0);

  let total_amount = subtotal + SHIPPING_FEE;

  // 6. Validate and apply coupon if provided
  let appliedCoupon = null;
  if (coupon_code) {
    try {
      const coupon = await Coupon.findOne({ code: coupon_code.toUpperCase(), isActive: true });

      if (!coupon) return next(createValidationError('Coupon not found or inactive'));
      if (coupon.expiresAt < new Date()) return next(createValidationError('Coupon has expired'));
      if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit)
        return next(createValidationError('Coupon usage limit reached'));
      if (subtotal < coupon.minOrderAmount)
        return next(createValidationError(`Minimum order amount is ${coupon.minOrderAmount}`));

      let discountAmount =
        coupon.discountType === 'percentage'
          ? (subtotal * coupon.discountValue) / 100
          : coupon.discountValue;

      if (coupon.discountType === 'percentage' && coupon.maxDiscountAmount) {
        discountAmount = Math.min(discountAmount, coupon.maxDiscountAmount);
      }

      total_amount = Math.max(total_amount - discountAmount, 0);
      appliedCoupon = coupon;
    } catch (err) {
      return next(err);
    }
  }

  // 7. Verify backend total matches frontend preview — reject before touching stock
  if (Math.abs(total_amount - Number(clientTotal)) > 0.01) {
    return next(
      createValidationError(
        'Order total does not match. Prices may have changed — please refresh and try again.'
      )
    );
  }

  const decrementedStock = [];

  try {
    for (const [bookId, quantity] of stockRequests) {
      const result = await Product.updateOne(
        { _id: bookId, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } }
      );

      if (result.modifiedCount === 0) {
        const product = productMap.get(bookId);
        throw createValidationError(
          `${product?.book_name || bookId} has only ${product?.stock ?? 0} item(s) in stock`
        );
      }

      decrementedStock.push({ bookId, quantity });
    }

    const doc = await Order.create({
      user_id: req.user.users._id,
      total_amount,
      status,
      order_item: verifiedOrderItems
    });

    if (appliedCoupon) {
      await Coupon.updateOne({ _id: appliedCoupon._id }, { $inc: { usedCount: 1 } });
    }

    await Cart.deleteMany({ user_id: req.user.users._id });

    return res.status(201).json({
      success: true,
      data: doc
    });
  } catch (err) {
    if (decrementedStock.length > 0) {
      await Promise.allSettled(
        decrementedStock.map(({ bookId, quantity }) =>
          Product.updateOne({ _id: bookId }, { $inc: { stock: quantity } })
        )
      );
    }

    next(err);
  }
};

export const updateOrderStatus = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid order id'
      });
    }

    const { status } = req.body;

    const doc = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      {
        new: true,
        runValidators: true
      }
    );

    if (!doc) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: doc
    });
  } catch (err) {
    next(err);
  }
};

export const deleteOrder = async (req, res, next) => {
  try {
    const doc = await Order.findByIdAndDelete(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    next(err);
  }
};

//User
export const getMyOrders = async (req, res, next) => {
  try {
    const orders = await Order.find({
      user_id: req.user.users._id
    });

    return res.status(200).json({
      success: true,
      data: orders
    });
  } catch (err) {
    next(err);
  }
};
