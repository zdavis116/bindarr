// A request-level invariant failure, carrying the HTTP status and a stable code
// so routes can translate one throw into the right response.
//
// This class used to live in utils/storageInvariants.js. When Storage was
// removed, deleting that file would have taken InvariantError with it -- and it
// is used 16 times in collection.js alone for things that have nothing to do
// with storage: "printing is not in the catalogue", "a printing can only be
// swapped within the same card", "this copy is checked out to a deck".
//
// A general-purpose class living inside a feature-specific module is why the
// removal looked bigger than it was. It belongs here.
class InvariantError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'InvariantError';
    this.status = status;
    this.code = code;
  }
}

module.exports = { InvariantError };
