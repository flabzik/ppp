import {
  BROKERS,
  EXCHANGE,
  INSTRUMENT_DICTIONARY,
  TRADER_DATUM,
  OPERATION_TYPE
} from '../const.js';
import {
  ConditionalOrderDatum,
  GlobalTraderDatum,
  Trader,
  pppTraderInstanceForWorkerIs
} from './trader-worker.js';
import { ConnectionError, TradingError } from '../ppp-exceptions.js';

export function toNumber({ num, scale }) {
  return num / 10 ** scale;
}

class PositionDatum extends GlobalTraderDatum {
  #timer;

  #shouldLoop = false;

  portfolio;

  positions = new Map();

  #getInstrument(position) {
    let symbol = position.securityCode;

    if (position.market === 'Mma') {
      symbol = `${symbol}~US`;
    } else if (position.market === 'Stock') {
      switch (symbol) {
        case 'ASTR':
          symbol = 'ASTR~MOEX';

          break;
        case 'FIVE':
          symbol = 'FIVE~MOEX';

          break;
        case 'GOLD':
          symbol = 'GOLD~MOEX';

          break;
      }
    }

    return this.trader.instruments.get(symbol);
  }

  firstReferenceAdded() {
    this.portfolio = null;

    clearTimeout(this.#timer);

    this.#shouldLoop = true;

    return this.#fetchPortfolioLoop();
  }

  lastReferenceRemoved() {
    this.portfolio = null;

    clearTimeout(this.#timer);

    this.#shouldLoop = false;
  }

  async #fetchPortfolioLoop() {
    if (this.#shouldLoop) {
      try {
        const { positions, money } = await this.trader.getPortfolio();
        const balances = {};

        for (const { currency, balance } of money ?? []) {
          balances[currency] ??= 0;
          balances[currency] = balances[currency] + balance;
        }

        for (const currency in balances) {
          this.dataArrived({
            isBalance: true,
            position: {
              currency,
              available: balances[currency]
            }
          });
        }

        const newPositions = new Set();

        if (Array.isArray(positions)) {
          for (const p of positions) {
            const positionId = `${p.securityCode}:${p.market}`;

            newPositions.add(positionId);

            this.positions.set(positionId, p);
            this.dataArrived({
              isBalance: false,
              position: p
            });
          }
        }

        for (const [positionId, position] of this.positions) {
          if (!newPositions.has(positionId)) {
            // This position has been closed.
            position.balance = 0;

            this.dataArrived({
              isBalance: false,
              position
            });
            this.positions.delete(positionId);
          }
        }

        this.#timer = setTimeout(() => {
          this.#fetchPortfolioLoop();
        }, 750);
      } catch (e) {
        console.error(e);

        this.#timer = setTimeout(() => {
          this.#fetchPortfolioLoop();
        }, 750);
      }
    }
  }

  filter(data, source, key, datum) {
    if (datum !== TRADER_DATUM.POSITION) {
      if (data.isBalance) {
        return data.position.currency === source.getAttribute('balance');
      }

      return this.trader.instrumentsAreEqual(
        this.#getInstrument(data.position),
        source.instrument
      );
    } else {
      return true;
    }
  }

  valueKeyForData(data) {
    if (data.isBalance) {
      return data.position.currency;
    } else {
      return `${data.position.securityCode}:${data.position.market}`;
    }
  }

  [TRADER_DATUM.POSITION](data) {
    if (data.isBalance) {
      return {
        symbol: data.position.currency,
        lot: 1,
        exchange: EXCHANGE.CUSTOM,
        isCurrency: true,
        isBalance: true,
        size: data.position.available,
        accountId: this.trader.document.account
      };
    } else {
      const { position } = data;
      const instrument = this.#getInstrument(position);

      if (instrument) {
        return {
          instrument,
          symbol: instrument.symbol,
          lot: instrument.lot,
          exchange: instrument.exchange,
          averagePrice: position.averagePrice,
          isCurrency: false,
          isBalance: false,
          size: position.balance,
          accountId: this.trader.document.account
        };
      }
    }
  }

  [TRADER_DATUM.POSITION_SIZE](data) {
    if (data.isBalance) {
      return data.position.available;
    } else {
      const instrument = this.#getInstrument(data.position);

      if (instrument) {
        return data.position.balance / instrument.lot;
      }
    }
  }

  [TRADER_DATUM.POSITION_AVERAGE](data) {
    if (!data.isBalance) {
      return data.position.averagePrice;
    }
  }
}

class OrderAndTimelineDatum extends GlobalTraderDatum {
  #timer;

  #shouldLoop = false;

  orders = [];

  filter(data, source, key, datum) {
    if (datum === TRADER_DATUM.REAL_ORDER) {
      // Count every type to remove orders properly.
      return true;
    } else if (datum === TRADER_DATUM.TIMELINE_ITEM) {
      return data.status === 'Matched';
    }
  }

  firstReferenceAdded() {
    this.orders = [];

    clearTimeout(this.#timer);

    this.#shouldLoop = true;

    return this.#fetchOrdersLoop();
  }

  lastReferenceRemoved() {
    this.orders = [];

    clearTimeout(this.#timer);

    this.#shouldLoop = false;
  }

  valueKeyForData(data) {
    return data.transactionId;
  }

  async #fetchOrdersLoop() {
    if (this.#shouldLoop) {
      try {
        this.orders = await this.trader.getOrdersAndExecutions();

        for (const o of this.orders) {
          this.dataArrived(o);
        }

        this.#timer = setTimeout(() => {
          this.#fetchOrdersLoop();
        }, 750);
      } catch (e) {
        console.error(e);

        this.#timer = setTimeout(() => {
          this.#fetchOrdersLoop();
        }, 750);
      }
    }
  }

  [TRADER_DATUM.REAL_ORDER](order) {
    const instrument = this.trader.securities
      .get(order.securityBoard)
      ?.get(order.securityCode);

    if (instrument) {
      return {
        instrument,
        orderId: order.orderNo,
        extraId: order.transactionId,
        symbol: instrument.symbol,
        exchange: instrument.exchange,
        orderType: 'limit',
        side: order.buySell.toLowerCase(),
        status: this.trader.getOrderStatus(order),
        placedAt: new Date(order.createdAt).toISOString(),
        endsAt: null,
        quantity: order.quantity,
        filled: order.quantity - order.balance,
        price: order.price
      };
    }
  }

  [TRADER_DATUM.TIMELINE_ITEM](order) {
    const instrument = this.trader.securities
      .get(order.securityBoard)
      ?.get(order.securityCode);

    if (instrument) {
      return {
        instrument,
        operationId: order.orderNo,
        accruedInterest: 0,
        commission: 0,
        parentId: order.orderNo,
        symbol: instrument.symbol,
        type:
          order.buySell === 'Buy'
            ? OPERATION_TYPE.OPERATION_TYPE_BUY
            : OPERATION_TYPE.OPERATION_TYPE_SELL,
        exchange: instrument.exchange,
        quantity: order.quantity,
        price: order.price,
        createdAt: order.createdAt
      };
    }
  }
}

// noinspection JSUnusedGlobalSymbols
/**
 * @typedef {Object} FinamTradeApiTrader
 */
class FinamTradeApiTrader extends Trader {
  #securities = new Map();

  connectorUrl;

  get securities() {
    return this.#securities;
  }

  constructor(document) {
    super(document, [
      {
        type: PositionDatum,
        datums: [
          TRADER_DATUM.POSITION,
          TRADER_DATUM.POSITION_SIZE,
          TRADER_DATUM.POSITION_AVERAGE
        ]
      },
      {
        type: OrderAndTimelineDatum,
        datums: [TRADER_DATUM.REAL_ORDER, TRADER_DATUM.TIMELINE_ITEM]
      },
      {
        type: ConditionalOrderDatum,
        datums: [TRADER_DATUM.CONDITIONAL_ORDER]
      }
    ]);

    if (typeof document.connectorUrl !== 'string') {
      throw new ConnectionError({ details: this });
    }
  }

  getTimeframeList() {
    return [
      {
        name: 'Sec',
        values: []
      },
      {
        name: 'Min',
        values: [1, 5, 15]
      },
      {
        name: 'Hour',
        values: [1]
      },
      {
        name: 'Day',
        values: [1]
      },
      {
        name: 'Week',
        values: [1]
      },
      {
        name: 'Month',
        values: []
      }
    ];
  }

  async instrumentsArrived(instruments) {
    for (const [, instrument] of instruments) {
      if (instrument.classCode) {
        if (!this.securities.has(instrument.classCode)) {
          this.securities.set(instrument.classCode, new Map());
        }

        this.securities
          .get(instrument.classCode)
          .set(this.getSymbol(instrument), instrument);
      }
    }

    return super.instrumentsArrived(instruments);
  }

  getOrderStatus(o = {}) {
    switch (o.status) {
      case 'Cancelled':
        return 'canceled';
      case 'Active':
        return 'working';
      case 'Matched':
        return 'filled';
      case 'None':
        return 'inactive';
      case 'Unknown':
        return 'unspecified';
    }
  }

  getExchange() {
    return EXCHANGE.CUSTOM;
  }

  getObservedAttributes() {
    return ['balance'];
  }

  getDictionary() {
    return INSTRUMENT_DICTIONARY.FINAM;
  }

  getBroker() {
    return BROKERS.FINAM;
  }

  async getPortfolio() {
    const portfolioResponse = await fetch(
      `${this.document.connectorUrl}fetch`,
      {
        method: 'POST',
        body: JSON.stringify({
          method: 'GET',
          url: `https://trade-api.finam.ru/public/api/v1/portfolio?ClientId=${this.document.account}&Content.IncludeMoney=true&Content.IncludePositions=true&Content.IncludeMaxBuySell=true`,
          headers: {
            'X-Api-Key': this.document.broker.token
          }
        })
      }
    );

    const { data } = await portfolioResponse.json();

    if (portfolioResponse.ok) {
      return data ?? {};
    } else {
      return {};
    }
  }

  async getOrdersAndExecutions() {
    const ordersResponse = await fetch(`${this.document.connectorUrl}fetch`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'GET',
        url: `https://trade-api.finam.ru/public/api/v1/orders?ClientId=${this.document.account}&IncludeMatched=true&IncludeCanceled=true&IncludeActive=true`,
        headers: {
          'X-Api-Key': this.document.broker.token
        }
      })
    });

    const { data } = await ordersResponse.json();

    if (ordersResponse.ok) {
      return data.orders ?? [];
    } else {
      return [];
    }
  }

  async modifyRealOrders({ instrument, side, value }) {
    const orders = this.datums[TRADER_DATUM.REAL_ORDER].orders;

    for (const o of orders) {
      const status = this.getOrderStatus(o);
      const orderInstrument = this.securities
        .get(o.securityBoard)
        ?.get(o.securityCode);

      if (
        status === 'working' &&
        (o.buySell.toLowerCase() === side || side === 'all')
      ) {
        if (
          instrument &&
          !this.instrumentsAreEqual(instrument, orderInstrument)
        )
          continue;

        if (orderInstrument?.minPriceIncrement >= 0) {
          // US stocks only.
          let minPriceIncrement = +o.price < 1 ? 0.0001 : 0.01;

          if (orderInstrument.exchange !== EXCHANGE.US) {
            minPriceIncrement = orderInstrument.minPriceIncrement;
          }

          const price = this.fixPrice(
            orderInstrument,
            +o.price + minPriceIncrement * value
          );

          o.extraId = o.transactionId;

          await this.cancelRealOrder(o);
          await this.placeLimitOrder({
            instrument: orderInstrument,
            price,
            quantity: o.balance,
            direction: o.buySell.toLowerCase()
          });
        }
      }
    }
  }

  async cancelAllRealOrders({ instrument, filter } = {}) {
    const orders = this.datums[TRADER_DATUM.REAL_ORDER].orders;

    for (const o of orders) {
      const status = this.getOrderStatus(o);
      const orderInstrument = this.securities
        .get(o.securityBoard)
        ?.get(o.securityCode);

      if (orderInstrument && status === 'working') {
        if (
          instrument &&
          !this.instrumentsAreEqual(instrument, orderInstrument)
        )
          continue;

        if (filter === 'buy' && o.buySell !== 'Buy') {
          continue;
        }

        if (filter === 'sell' && o.buySell !== 'Sell') {
          continue;
        }

        o.extraId = o.transactionId;

        await this.cancelRealOrder(o);
      }
    }
  }

  async cancelRealOrder(order) {
    const orderResponse = await fetch(`${this.document.connectorUrl}fetch`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'DELETE',
        url: `https://trade-api.finam.ru/public/api/v1/orders/?ClientId=${this.document.account}&TransactionId=${order.extraId}`,
        headers: {
          'X-Api-Key': this.document.broker.token
        }
      })
    });

    const orderData = await orderResponse.json();

    if (orderResponse.ok) {
      return {
        orderId: order.orderId
      };
    } else {
      throw new TradingError({
        message: orderData.error?.message
      });
    }
  }

  async placeLimitOrder({ instrument, price, quantity, direction }) {
    const payload = {
      clientId: this.document.account,
      securityBoard: instrument.classCode,
      securityCode: this.getSymbol(instrument),
      buySell: direction === 'buy' ? 'Buy' : 'Sell',
      quantity,
      useCredit: true,
      property: 'PutInQueue'
    };

    if (price !== 0) {
      payload.price = this.fixPrice(instrument, price);
    }

    const orderResponse = await fetch(`${this.document.connectorUrl}fetch`, {
      method: 'POST',
      body: JSON.stringify({
        url: 'https://trade-api.finam.ru/public/api/v1/orders',
        headers: {
          'X-Api-Key': this.document.broker.token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })
    });

    const order = await orderResponse.json();

    if (!orderResponse.ok) {
      throw new TradingError({
        details: order
      });
    } else {
      return {
        orderId: order.orderId
      };
    }
  }

  async placeMarketOrder({ instrument, quantity, direction }) {
    return this.placeLimitOrder({ instrument, quantity, direction, price: 0 });
  }

  async historicalCandles({ instrument, unit, value, cursor }) {
    instrument = this.adoptInstrument(instrument);

    if (instrument.notSupported) {
      return {
        candles: []
      };
    }

    let routeSuffix = 'intraday-candles';

    if (unit === 'Day' || unit === 'Week') {
      routeSuffix = 'day-candles';
    }

    let tf;

    switch (unit) {
      case 'Sec':
        return {
          candles: []
        };
      case 'Min':
        if ([1, 5, 15].includes(value)) {
          tf = `M${value}`;

          break;
        } else {
          return {
            candles: []
          };
        }
      case 'Hour':
        if (value === 1) {
          tf = 'H1';

          break;
        } else {
          return {
            candles: []
          };
        }
      case 'Day':
        if (value === 1) {
          tf = 'D1';

          break;
        } else {
          return {
            candles: []
          };
        }
      case 'Week':
        if (value === 1) {
          tf = 'W1';

          break;
        } else {
          return {
            candles: []
          };
        }
      case 'Month':
        return {
          candles: []
        };
    }

    let to = cursor ?? new Date().toISOString();

    if (routeSuffix === 'day-candles') {
      to = to.split('T')[0];
    }

    const params = [
      `SecurityBoard=${instrument.classCode}`,
      `SecurityCode=${this.getSymbol(instrument)}`,
      `TimeFrame=${tf}`,
      'Interval.Count=500',
      `Interval.To=${to}`
    ].join('&');
    const candlesResponse = await fetch(`${this.document.connectorUrl}fetch`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'GET',
        url: `https://trade-api.finam.ru/public/api/v1/${routeSuffix}?${params}`,
        headers: {
          'X-Api-Key': this.document.broker.token
        }
      })
    });

    if (!candlesResponse.ok) {
      return {
        candles: []
      };
    }

    const { data } = await candlesResponse.json();

    // To is inclusive.
    if (cursor) {
      data.candles.pop();
    }

    return {
      cursor:
        routeSuffix === 'day-candles'
          ? data?.candles[0]?.date
          : data?.candles[0]?.timestamp,
      candles:
        data.candles?.map((c) => {
          return {
            open: toNumber(c.open),
            high: toNumber(c.high),
            low: toNumber(c.low),
            close: toNumber(c.close),
            time:
              routeSuffix === 'day-candles'
                ? new Date(c.date).toISOString()
                : c.timestamp,
            volume: c.volume
          };
        }) ?? []
    };
  }

  getErrorI18nKey({ error }) {
    const details = error.details;

    if (details?.error) {
      if (
        /Money shortage/i.test(details.error?.message) ||
        /No enough coverage/i.test(details.error?.message)
      ) {
        return 'E_INSUFFICIENT_FUNDS';
      } else if (/market standby mode/i.test(details.error?.message)) {
        return 'E_INSTRUMENT_NOT_TRADEABLE';
      } else if (
        /Execution route selection failed/i.test(details.error?.message)
      ) {
        return 'E_ROUTING_ERROR';
      } else if (
        /confirm your qualification level/i.test(details.error?.message)
      ) {
        return 'E_NO_QUALIFICATION';
      }
    } else if (error.error) {
      if (
        /Trading on the instrument is not available/i.test(error.error.message)
      ) {
        return 'E_INSTRUMENT_NOT_TRADEABLE';
      }
    }
  }

  adoptInstrument(instrument = {}, options = {}) {
    if (
      (instrument.exchange === EXCHANGE.US ||
        (instrument.exchange === EXCHANGE.SPBX &&
          options.origin !== 'search-control') ||
        instrument.exchange === EXCHANGE.UTEX_MARGIN_STOCKS) &&
      this.instruments.has(`${instrument.symbol}~US`)
    ) {
      return this.instruments.get(`${instrument.symbol}~US`);
    }

    if (
      instrument.exchange === EXCHANGE.MOEX &&
      this.getSymbol(instrument) === 'ASTR'
    ) {
      return this.instruments.get('ASTR~MOEX');
    }

    if (
      instrument.exchange === EXCHANGE.MOEX &&
      this.getSymbol(instrument) === 'FIVE'
    ) {
      return this.instruments.get('FIVE~MOEX');
    }

    if (
      instrument.exchange === EXCHANGE.MOEX &&
      this.getSymbol(instrument) === 'GOLD'
    ) {
      return this.instruments.get('GOLD~MOEX');
    }

    if (
      instrument.symbol === 'TCS' &&
      (instrument.exchange === EXCHANGE.US ||
        instrument.exchange === EXCHANGE.UTEX_MARGIN_STOCKS)
    ) {
      return this.instruments.get('TCS~US');
    }

    return super.adoptInstrument(instrument, options);
  }
}

pppTraderInstanceForWorkerIs(FinamTradeApiTrader);

export default FinamTradeApiTrader;
