/**
 * Load-test scenarios.
 *
 * Design rules:
 *
 *  - NO Razorpay, ever. The only mutating scenario is COD order creation. There is
 *    no path in this file that can reach a payment provider.
 *  - Login is never load tested. `POST /api/auth/login` is deliberately limited to
 *    20 attempts per 15 minutes by `authLimiter`, so hammering it would measure
 *    the rate limiter rather than the application. Tokens are minted during
 *    seeding instead, which is also how real traffic behaves: a user logs in once
 *    and then makes many authenticated requests.
 *
 * Two autocannon behaviours drive the shape of this file, both established by
 * reading `node_modules/autocannon/lib`:
 *
 *  1. Dynamic requests must be built with `setupRequest(reqData)`, which receives
 *     the merged request and must RETURN a request object. A function-valued
 *     `path`, `headers` or `body` is silently accepted and then produces requests
 *     that never complete - measured directly: 24,883 requests sent, 0 completed.
 *
 *  2. autocannon has no `weight` option. The `requests` array is cycled
 *     round-robin by `RequestIterator.nextRequest()`. Relative request
 *     frequencies are therefore expressed by repeating entries in the array, and
 *     the resulting mix is exactly proportional to the repetition counts.
 *
 * `setupRequest` always spreads the incoming `reqData` and overrides only what it
 * needs, because the builder has already merged in the host/port derived from the
 * target URL and a fresh object would drop it.
 */

/** Expand `{ weight, build }` specs into a round-robin array of setupRequest entries. */
function expand(specs) {
  const out = [];
  for (const spec of specs) {
    for (let i = 0; i < spec.weight; i++) {
      out.push({
        setupRequest: (reqData) => spec.build(reqData),
      });
    }
  }
  return out;
}

module.exports = function buildScenarios(tokens) {
  const customers = tokens.customers;
  const productIds = tokens.productIds;
  const categoryIds = tokens.categoryIds || [];
  const orderNumbers = tokens.orderNumbers || [];
  // Users who already hold a cart, used by the checkout scenarios.
  const cartCustomers = tokens.cartCustomers && tokens.cartCustomers.length ? tokens.cartCustomers : customers;
  // Products verified as purchasable (active, deep stock). Checkout uses these so
  // that order creation is not rejected by stock validation for a fifth of requests,
  // which would measure stock exhaustion instead of checkout throughput.
  const checkoutProductIds =
    tokens.checkoutProductIds && tokens.checkoutProductIds.length ? tokens.checkoutProductIds : productIds;

  let c = 0;
  const nextCustomer = () => customers[c++ % customers.length];
  let p = 0;
  const nextProduct = () => productIds[p++ % productIds.length];
  let p2 = 0;
  const nextProductIndex = () => p2++;
  let o = 0;
  const nextOrderNumber = () => orderNumbers[o++ % orderNumbers.length] || 'AKLT1000000';

  // Search terms drawn from the seeded product names so searches actually match
  // rows rather than always missing.
  const SEARCH_TERMS = [
    'brake', 'filter', 'oil', 'spark plug', 'suspension', 'shock', 'headlight',
    'wiper', 'radiator', 'battery', 'clutch', 'bearing', 'Bosch', 'Tata',
    'Nexon', 'Tigor', 'bumper', 'mirror', 'belt',
  ];

  let s = 0;
  const nextSearchTerm = () => s++;

  const withAuth = (reqData, token) => ({
    ...reqData,
    headers: { ...reqData.headers, authorization: `Bearer ${token}` },
  });

  const COD_ADDRESS = {
    fullName: 'Load Test Buyer',
    phone: '9876543210',
    addressLine1: '12 Test Street',
    addressLine2: '',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400001',
    country: 'India',
  };

  const customerGet = (pathFn) => ({
    weight: 1,
    build: (reqData) => withAuth({ ...reqData, method: 'GET', path: pathFn() }, nextCustomer()),
  });

  const plainGet = (path) => ({ weight: 1, build: (reqData) => ({ ...reqData, method: 'GET', path }) });

  // Checkout pairing.
  //
  // Creating an order requires a non-empty cart, and each successful order empties
  // it. An add-to-cart and a create-order therefore have to target the SAME user, or
  // the create lands on an empty cart and returns 400 - a measurement of the test's
  // own bookkeeping rather than of checkout throughput.
  //
  // Getting that pairing right under concurrency needs three facts about autocannon,
  // all established by reading `node_modules/autocannon/lib`:
  //
  //   1. Each CONNECTION owns its own `RequestIterator` (`httpClient.js:36`), and each
  //      iterator walks the `requests` array independently. So at 5 connections there
  //      are 5 independent add/create cycles in flight, not one global cycle.
  //   2. `RequestIterator.nextRequest()` calls `resetContext()` each time the array
  //      wraps (`requestIterator.js:47`), and `resetContext()` REPLACES the context
  //      object with a fresh deep clone. With a two-entry array that wrap happens
  //      exactly between a create-order and the next add-to-cart - i.e. precisely at
  //      the point where the pairing has been consumed.
  //   3. `buildRequest()` passes that per-connection context as the second argument to
  //      `setupRequest` (`httpRequestBuilder.js:35`).
  //
  // So the pending user's token is stashed ON that context object and read back by the
  // create-order that follows it on the same connection. It cannot leak into another
  // connection (separate context) and cannot survive into the next cycle (wiped by
  // the wrap) - which is exactly the required lifetime.
  //
  // The first version of this used one shared `Math.floor(counter++ / 2)` cursor and
  // paired requests purely by global arrival order. That is only correct at ONE
  // connection. At five, several add-to-cart requests are built before any
  // create-order, so the cursor drifts out of step and roughly a third of orders
  // targeted a user whose cart had already been consumed - a measured 35% error rate
  // that was entirely the harness's fault.
  //
  // Uniqueness of the user across connections comes from a shared allocator function
  // placed in `initialContext`. `lodash.clonedeep` returns FUNCTION values by
  // reference rather than copying them, so although every connection's context is a
  // deep clone, all of them end up holding the same allocator and therefore drawing
  // from one monotonic sequence - no two connections can be handed the same user.
  let checkoutUserCursor = 0;
  const allocCheckoutUser = () => cartCustomers[checkoutUserCursor++ % cartCustomers.length];

  const addToCart = {
    setupRequest: (reqData, ctx) => {
      const token = ctx.akCheckoutToken || allocCheckoutUser();
      ctx.akCheckoutToken = token;
      return withAuth(
        {
          ...reqData,
          method: 'POST',
          path: '/api/cart',
          body: JSON.stringify({
            productId: checkoutProductIds[nextProductIndex() % checkoutProductIds.length],
            quantity: 1,
          }),
        },
        token
      );
    },
  };

  // Only COD. `paymentMethod: 'online'` is rejected by the controller with a 400
  // before any provider call, so even a bug here cannot reach Razorpay.
  const createCodOrder = {
    setupRequest: (reqData, ctx) =>
      withAuth(
        {
          ...reqData,
          method: 'POST',
          path: '/api/orders',
          body: JSON.stringify({ paymentMethod: 'cod', shippingAddress: COD_ADDRESS }),
        },
        ctx.akCheckoutToken || allocCheckoutUser()
      ),
  };

  // Handed to autocannon so each connection's cloned context carries the shared
  // allocator. See point 3 above.
  const checkoutInitialContext = { allocCheckoutUser };

  return {
    /**
     * Read-heavy catalogue browsing, anonymous. This is the single most common
     * real-world shape for a parts store: mostly anonymous, mostly reads.
     * Weights here total 100, matching a plausible share of page views.
     */
    'catalogue-anonymous': {
      description: 'Anonymous catalogue browsing (list, search, detail, category, rails)',
      auth: false,
      requests: expand([
        { weight: 30, build: (r) => ({ ...r, method: 'GET', path: '/api/products' }) },
        { weight: 10, build: (r) => ({ ...r, method: 'GET', path: '/api/products?page=2' }) },
        { weight: 8, build: (r) => ({ ...r, method: 'GET', path: '/api/products?sort=price_low' }) },
        { weight: 8, build: (r) => ({ ...r, method: 'GET', path: '/api/products?sort=newest' }) },
        { weight: 6, build: (r) => ({ ...r, method: 'GET', path: '/api/products?inStock=true&page=3' }) },
        { weight: 8, build: (r) => ({ ...r, method: 'GET', path: `/api/products/search?q=${SEARCH_TERMS[0]}` }) },
        { weight: 6, build: (r) => ({ ...r, method: 'GET', path: `/api/products/search?q=${SEARCH_TERMS[3]}` }) },
        { weight: 5, build: (r) => ({ ...r, method: 'GET', path: `/api/products/search?q=${SEARCH_TERMS[13]}` }) },
        { weight: 6, build: (r) => ({ ...r, method: 'GET', path: '/api/products/featured' }) },
        { weight: 5, build: (r) => ({ ...r, method: 'GET', path: '/api/products/best-deals' }) },
        { weight: 4, build: (r) => ({ ...r, method: 'GET', path: '/api/products/tata-bs6' }) },
        { weight: 4, build: (r) => ({ ...r, method: 'GET', path: '/api/products/condition/used' }) },
      ]),
    },

    /** Single hottest endpoint on its own, for a clean per-endpoint number. */
    'product-list-anonymous': {
      description: 'GET /api/products only (single hottest endpoint)',
      auth: false,
      requests: expand([plainGet('/api/products')]),
    },

    'product-detail-anonymous': {
      description: 'GET /api/products/:id (single product detail)',
      auth: false,
      requests: expand([{ weight: 1, build: (r) => ({ ...r, method: 'GET', path: `/api/products/${nextProduct()}` }) }]),
    },

    /**
     * Search on its own, so the report can say what the text search costs rather
     * than folding it into the catalogue average. The terms rotate round-robin
     * instead of repeating one, because a single repeated term hits the same
     * cached query plan and the same set of matching documents every time, which
     * flatters the result.
     */
    'product-search-anonymous': {
      description: 'GET /api/products/search?q=... (rotating search terms)',
      auth: false,
      requests: expand([
        { weight: 1, build: (r) => ({ ...r, method: 'GET', path: `/api/products/search?q=${SEARCH_TERMS[nextSearchTerm() % SEARCH_TERMS.length]}` }) },
        { weight: 1, build: (r) => ({ ...r, method: 'GET', path: `/api/products/search?q=${SEARCH_TERMS[nextSearchTerm() % SEARCH_TERMS.length]}` }) },
        { weight: 1, build: (r) => ({ ...r, method: 'GET', path: `/api/products/search?q=${SEARCH_TERMS[nextSearchTerm() % SEARCH_TERMS.length]}` }) },
        { weight: 1, build: (r) => ({ ...r, method: 'GET', path: `/api/products/search?q=${SEARCH_TERMS[nextSearchTerm() % SEARCH_TERMS.length]}` }) },
        { weight: 1, build: (r) => ({ ...r, method: 'GET', path: `/api/products/search?q=${SEARCH_TERMS[nextSearchTerm() % SEARCH_TERMS.length]}` }) },
      ]),
    },

    'category-list-anonymous': {
      description: 'GET /api/categories only',
      auth: false,
      requests: expand([plainGet('/api/categories')]),
    },

    /**
     * Authenticated read traffic. Each request carries a different Bearer token
     * from a pool of seeded customers, so the server performs a real user lookup
     * per request - which is the behaviour audit finding F-03 requires, and the
     * reason no authentication cache is used.
     */
    'authenticated-reads': {
      description: 'Authenticated reads (/auth/me, /cart, /wishlist, /orders)',
      auth: true,
      requests: expand([
        { weight: 25, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/auth/me' }, nextCustomer()) },
        { weight: 25, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/cart' }, nextCustomer()) },
        { weight: 20, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/wishlist' }, nextCustomer()) },
        { weight: 20, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/orders' }, nextCustomer()) },
        { weight: 5, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/orders?page=2' }, nextCustomer()) },
        { weight: 5, build: (r) => ({ ...r, method: 'GET', path: '/api/products' }) },
      ]),
    },

    /**
     * COD checkout: add to cart, then create the order. Each order consumes the
     * user's cart, so this is bounded by how many seeded users hold a cart. Run at
     * low concurrency only, and the report says so.
     */
    'cod-checkout': {
      description: 'COD checkout (add to cart, then create COD order)',
      auth: true,
      lowConcurrencyOnly: true,
      maxConcurrency: 50,
      initialContext: checkoutInitialContext,
      // Exactly two entries, and they must be ADJACENT. autocannon walks the array
      // in order, so each connection alternates add, create, add, create. Giving
      // either a higher weight would group all the adds ahead of all the creates,
      // so half the orders would target users whose cart had not been primed yet
      // and return 400 - a test artefact that looked like an application failure.
      requests: [addToCart, createCodOrder],
    },

    'order-history': {
      description: 'Authenticated order history and order tracking',
      auth: true,
      requests: expand([
        { weight: 40, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/orders' }, nextCustomer()) },
        { weight: 20, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/orders?limit=20&page=2' }, nextCustomer()) },
        { weight: 40, build: (r) => ({ ...r, method: 'GET', path: `/api/orders/track/${nextOrderNumber()}` }) },
      ]),
    },

    /**
     * Admin surfaces, deliberately measured at low concurrency only. These are the
     * heaviest queries in the app (dashboard aggregation, user search), but real
     * admin traffic is a handful of people, so a 1000-connection admin test would
     * measure a scenario that does not exist.
     */
    'admin-reads': {
      description: 'Admin dashboard, orders and users (low concurrency only)',
      auth: true,
      adminOnly: true,
      lowConcurrencyOnly: true,
      maxConcurrency: 25,
      requests: expand([
        { weight: 20, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/admin/dashboard' }, tokens.admin) },
        { weight: 30, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/admin/orders?limit=20' }, tokens.admin) },
        { weight: 30, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/admin/users?limit=20' }, tokens.admin) },
        { weight: 20, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/admin/orders?status=delivered&limit=20' }, tokens.admin) },
      ]),
    },

    /**
     * The realistic blend: mostly anonymous browsing, a meaningful share of
     * authenticated reads, a little checkout, no admin. Weights total 100.
     */
    'mixed-ecommerce': {
      description: 'Realistic blend of anonymous browsing, authenticated reads and checkout',
      auth: false,
      initialContext: checkoutInitialContext,
      requests: [
        ...expand([
          // anonymous browsing - 70
          { weight: 26, build: (r) => ({ ...r, method: 'GET', path: '/api/products' }) },
          { weight: 10, build: (r) => ({ ...r, method: 'GET', path: '/api/products?sort=price_low' }) },
          { weight: 10, build: (r) => ({ ...r, method: 'GET', path: '/api/products/search?q=brake' }) },
          { weight: 8, build: (r) => ({ ...r, method: 'GET', path: '/api/products/search?q=filter' }) },
          { weight: 6, build: (r) => ({ ...r, method: 'GET', path: '/api/products/featured' }) },
          { weight: 5, build: (r) => ({ ...r, method: 'GET', path: '/api/products/best-deals' }) },
          { weight: 5, build: (r) => ({ ...r, method: 'GET', path: '/api/categories' }) },
          // authenticated reads - 25
          { weight: 8, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/auth/me' }, nextCustomer()) },
          { weight: 6, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/cart' }, nextCustomer()) },
          { weight: 5, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/wishlist' }, nextCustomer()) },
          { weight: 6, build: (r) => withAuth({ ...r, method: 'GET', path: '/api/orders' }, nextCustomer()) },
        ]),
        // Checkout is appended as two ADJACENT single-weight entries rather than
        // folded into the weights above. `expand` groups entries by weight, so
        // weighting them here would place every add-to-cart before every order
        // creation and break the pairing that keeps each order's cart primed.
        addToCart,
        createCodOrder,
      ],
    },
  };
};