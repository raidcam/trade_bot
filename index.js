const axios = require('axios');
const { RSI, SMA, MACD } = require('technicalindicators');
const Binance = require('binance-api-node').default;
const readlineSync = require('readline-sync');
const winston = require('winston');
// Налаштування логування за допомогою бібліотеки Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot.log' })
    ]
});
// Функція для отримання ринкових даних з Binance API
async function getMarketData(symbol, interval) {
    const response = await axios.get(`https://api.binance.com/api/v3/klines`, {
        params: {
            symbol: symbol,
            interval: interval
        }
    });
    return response.data.map(candle => ({
        openTime: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: candle[6],
    }));
}
// Функція для розрахунку технічних індикаторів (RSI, SMA, MACD, волатильність)
function calculateIndicators(marketData) {
    const closePrices = marketData.map(data => data.close);

    const rsi = RSI.calculate({ values: closePrices, period: 14 });
    const ma = SMA.calculate({ values: closePrices, period: 14 });
    const macd = MACD.calculate({
        values: closePrices,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    });
    // Розрахунок волатильності (наприклад, стандартне відхилення закритих цін)
    const mean = closePrices.reduce((acc, price) => acc + price, 0) / closePrices.length;
    const squaredDiffs = closePrices.map(price => Math.pow(price - mean, 2));
    const variance = squaredDiffs.reduce((acc, diff) => acc + diff, 0) / closePrices.length;
    const volatility = Math.sqrt(variance);
    return { rsi, ma, macd, volatility, closePrices };
}
// Функція для розміщення ордеру з стоп-лоссом та тейк-профітом
async function placeOrderWithStopLossAndTakeProfit(client, symbol, side, quantity, stopPrice, takeProfitPrice) {
    try {
        const order = await client.order({
            symbol: symbol,
            side: side,
            type: 'MARKET',
            quantity: quantity,
        });
        logger.info(`Market order placed: ${JSON.stringify(order)}`);
        // Встановлення стоп-лоссу
        const stopSide = side === 'BUY' ? 'SELL' : 'BUY';
        const stopLossOrder = await client.order({
            symbol: symbol,
            side: stopSide,
            type: 'STOP_MARKET',
            stopPrice: stopPrice,
            quantity: quantity,
        });
        logger.info(`Stop-Loss order placed: ${JSON.stringify(stopLossOrder)}`);
        // Встановлення тейк-профіту
        const takeProfitOrder = await client.order({
            symbol: symbol,
            side: stopSide,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: takeProfitPrice,
            quantity: quantity,
        });
        logger.info(`Take-Profit order placed: ${JSON.stringify(takeProfitOrder)}`);
        return order;
    } catch (error) {
        logger.error(`Failed to place order: ${error.message}`);
        throw error;
    }
}

// Функція для отримання відкритих позицій
async function getOpenPositions(client, symbol) {
    try {
        const openOrders = await client.openOrders({ symbol: symbol });
        return openOrders.length;
    } catch (error) {
        logger.error(`Failed to get open positions: ${error.message}`);
        throw error;
    }
}
// Функція для перевірки валідності символу
async function validateSymbol(client, symbol) {
    try {
        const exchangeInfo = await client.exchangeInfo();
        const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
        return !!symbolInfo;
    } catch (error) {
        logger.error(`Failed to validate symbol: ${error.message}`);
        throw error;
    }
}

// Функція для аналізу ринку та прийняття рішень про торгові операції
async function analyzeMarket(client, symbol) {
    const marketData = await getMarketData(symbol, '1h');
    const { rsi, ma, macd, volatility, closePrices } = calculateIndicators(marketData);
    const currentPrice = closePrices[closePrices.length - 1];
    const minOrderAmount = 5; // Мінімальна сума ордеру в USD
    const quantity = (minOrderAmount / currentPrice).toFixed(6); // Розрахунок кількості для мінімальної суми ордеру

    logger.info(`RSI: ${rsi[rsi.length - 1]}`);
    logger.info(`MA: ${ma[ma.length - 1]}`);
    logger.info(`MACD: ${JSON.stringify(macd[macd.length - 1])}`);
    logger.info(`Volatility: ${volatility}`);
    logger.info(`Current Price: ${currentPrice}`);
    logger.info(`Calculated Quantity: ${quantity}`);

    const openPositions = await getOpenPositions(client, symbol);
    logger.info(`Open Positions: ${openPositions}`);

    // Перевірка, щоб бот не відкривав більше 2 позицій одночасно
    if (openPositions >= 2) {
        logger.info(`Position limit reached for ${symbol}`);
        return;
    }
    // Прийняття рішень на основі RSI, MA, MACD і волатильності
    if (rsi[rsi.length - 1] < 30 && ma[ma.length - 1] > currentPrice && macd[macd.length - 1].MACD > macd[macd.length - 1].signal && volatility > 0.005) {
        // Відкриття довгої позиції
        logger.info(`Opening a long position for ${symbol}`);
        const stopPrice = currentPrice * 0.95; // Наприклад: 5% стоп-лосс
        const takeProfitPrice = currentPrice * 1.05; // Наприклад: 5% тейк-профіт
        await placeOrderWithStopLossAndTakeProfit(client, symbol, 'BUY', quantity, stopPrice, takeProfitPrice);
    } else if (rsi[rsi.length - 1] > 70 && ma[ma.length - 1] < currentPrice && macd[macd.length - 1].MACD < macd[macd.length - 1].signal && volatility > 0.005) {
        // Відкриття короткої позиції
        logger.info(`Opening a short position for ${symbol}`);
        const stopPrice = currentPrice * 1.05; // Наприклад: 5% стоп-лосс
        const takeProfitPrice = currentPrice * 0.95; // Наприклад: 5% тейк-профіт
        await placeOrderWithStopLossAndTakeProfit(client, symbol, 'SELL', quantity, stopPrice, takeProfitPrice);
    } else {
        logger.info(`No trade signal for ${symbol}`);
    }
}

// Основна функція для запуску бота
async function main() {
    try {
        const apiKey = readlineSync.question('Enter your Binance API key: ', { hideEchoBack: true });
        const apiSecret = readlineSync.question('Enter your Binance API secret: ', { hideEchoBack: true });
        const symbol = readlineSync.question('Enter the trading pair (e.g., BTCUSDT): ');
        const client = Binance({
            apiKey: apiKey,
            apiSecret: apiSecret,
        });
        const isValidSymbol = await validateSymbol(client, symbol);
        if (!isValidSymbol) {
            logger.error(`Invalid symbol: ${symbol}`);
            return;
        }
        // Аналіз ринку кожні 5 секунд
        setInterval(() => {
            analyzeMarket(client, symbol);
        }, 5000); // Analyze market every 5 seconds
    } catch (error) {
        logger.error(`An error occurred: ${error.message}`);
    }
}
// Запуск основної функції
main();
