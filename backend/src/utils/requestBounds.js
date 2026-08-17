class RequestBoundsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestBoundsError';
    this.status = status;
  }
}

function positiveInteger(value, { name, max }) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RequestBoundsError(400, `${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new TypeError('positiveInteger requires an explicit positive integer max');
  }
  if (value > max) {
    throw new RequestBoundsError(413, `${name} cannot exceed ${max}`);
  }
  return value;
}

function requireArray(value, { name, minLength = 0, maxLength } = {}) {
  if (!Array.isArray(value)) {
    throw new RequestBoundsError(400, `${name} must be an array`);
  }
  if (value.length < minLength) {
    throw new RequestBoundsError(400, `${name} must contain at least ${minLength} item${minLength === 1 ? '' : 's'}`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new RequestBoundsError(413, `${name} cannot contain more than ${maxLength} items`);
  }
  return value;
}

function uniqueIntegerIds(value, { name, maxLength } = {}) {
  const ids = requireArray(value, { name, minLength: 1, maxLength });
  const seen = new Set();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) {
      throw new RequestBoundsError(400, `${name} must contain unique positive integer IDs`);
    }
    seen.add(id);
  }
  return ids;
}

function boundedProduct(factors, { name, max }) {
  requireArray(factors, { name, minLength: 1 });
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new TypeError('boundedProduct requires an explicit non-negative integer max');
  }
  let product = 1;
  for (const factor of factors) {
    if (!Number.isSafeInteger(factor) || factor < 0) {
      throw new RequestBoundsError(400, `${name} factors must be non-negative integers`);
    }
    if (factor !== 0 && product > Math.floor(max / factor)) {
      throw new RequestBoundsError(413, `${name} cannot exceed ${max}`);
    }
    product *= factor;
  }
  return product;
}

module.exports = {
  RequestBoundsError,
  positiveInteger,
  requireArray,
  uniqueIntegerIds,
  boundedProduct
};
