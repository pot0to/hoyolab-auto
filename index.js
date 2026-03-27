const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const Command = require("./classes/command.js");
const Config = require("./classes/config.js");
const Got = require("./classes/got.js");

const Cache = require("./singleton/cache.js");
const Logger = require("./singleton/logger.js");
const Utils = require("./singleton/utils.js");
const TestNotification = require("./singleton/test-notification.js");

const HoyoLab = require("./hoyolab-modules/template.js");
const Platform = require("./platforms/template.js");
const config = require("./config.js");

const CheckIn = require("./crons/check-in/index.js");

let nodemailer;
try {
	nodemailer = require("nodemailer");
}
catch (e) {
	nodemailer = null;
}

const Date = require("./object/date.js");
const Error = require("./object/error.js");
const RegionalTaskManager = require("./object/regional-task-manager.js");

const configFilePath = process.env.CONFIG_PATH || "./config.json5";
const cookieRefreshPort = Number(process.env.COOKIE_REFRESH_PORT ?? 3002);
const cookieRefreshHost = process.env.COOKIE_REFRESH_HOST || "0.0.0.0";
const cookieRefreshBaseUrl = process.env.COOKIE_REFRESH_BASE_URL || `http://localhost:${cookieRefreshPort}`;

// Global status tracking for monitoring
let botStatus = {
	version: require("./package.json").version,
	cookieStatus: {},
	characters: []
};

function getOrInitializeCharacter(gameType, uid, username, region) {
	// Find existing character
	let character = botStatus.characters.find(char => char.platform === gameType && char.uid === uid);
	
	if (!character) {
		// Create new character
		character = {
			platform: gameType,
			uid: uid,
			username: username,
			region: region,
			runs: []
		};
		botStatus.characters.push(character);
	}
	
	return character;
}

function getOrInitializeDailyRun(character, date) {
	// Check if today's run already exists
	let todayRun = character.runs.find(run => run.date === date);
	if (!todayRun) {
		todayRun = {
			date: date,
			lastRunTimestamp: new Date().toISOString(),
			redeems: [],
			todaySummary: {
				totalSignIns: 0,
				todaysRewards: {}
			}
		};
		character.runs.push(todayRun);
		// Keep only last 30 days
		if (character.runs.length > 30) {
			character.runs = character.runs.slice(-30);
		}
	} else {
		// Update the last run timestamp
		todayRun.lastRunTimestamp = new Date().toISOString();
	}
	return todayRun;
}

function updateBotStatus(type, data) {
	botStatus.lastUpdate = new Date().toISOString();

	const today = new Date().toISOString().split('T')[0];

	if (type === 'checkIn') {
		// Track each character's check-in results
		data.results.forEach(result => {
			const character = getOrInitializeCharacter(result.platform, result.uid, result.username, result.region);
			const dailyRun = getOrInitializeDailyRun(character, today);
			
			// Add the check-in reward to today's redeems
			dailyRun.redeems.push({
				name: result.rewardName || result.reward,
				count: result.rewardCount || 1,
				source: 'checkIn',
				timestamp: new Date().toISOString(),
				result: result.result
			});
			
			// Update per-character summary for successful check-ins and already-sign-in status
			const resultText = (result.result || "").toLowerCase();
			const signInDetected =
				resultText.includes("congratulations") ||
				resultText.includes("successfully") ||
				resultText.includes("already checked in") ||
				resultText.includes("already signed in") ||
				resultText.includes("already checked in today") ||
				resultText.includes("already signed in today");

			if (signInDetected) {
				dailyRun.todaySummary.totalSignIns++;

				// Aggregate today's rewards
				const rewardName = result.rewardName || result.reward;
				const rewardCount = result.rewardCount || 1;
				if (rewardName) {
					dailyRun.todaySummary.todaysRewards[rewardName] =
						(dailyRun.todaySummary.todaysRewards[rewardName] || 0) + rewardCount;
				}
			}
		});
	}
	else if (type === 'redeem') {
		// Track code redemptions per character
		const { gameType, uid, username, region, code, item, status, timestamp } = data;
		const character = getOrInitializeCharacter(gameType, uid, username, region);
		const dailyRun = getOrInitializeDailyRun(character, today);
		
		// Add the redeemed item to today's redeems
		if (status === 'success') {
			dailyRun.redeems.push({
				name: item,
				source: 'redeemCode',
				code: code,
				timestamp: timestamp || new Date().toISOString(),
				status: 'success'
			});
		} else if (status === 'failed') {
			dailyRun.redeems.push({
				name: item || 'Unknown',
				source: 'redeemCode',
				code: code,
				timestamp: timestamp || new Date().toISOString(),
				status: 'failed'
			});
		}
	}
	else if (type === 'cookieExpired') {
		botStatus.cookieStatus[data.uid] = {
			status: 'expired',
			platform: data.platform,
			lastChecked: new Date().toISOString(),
			message: 'Cookie expired - manual refresh required'
		};
	}
	else if (type === 'cookieValid') {
		botStatus.cookieStatus[data.uid] = {
			status: 'valid',
			platform: data.platform,
			lastChecked: new Date().toISOString()
		};
	}
}

function saveConfig () {
	fs.writeFileSync(configFilePath, require("json5").stringify(config, null, 4));
}

async function sendEmailNotification (subject, body) {
	if (!config.email?.enabled) {
		return false;
	}
	if (!nodemailer) {
		app.Logger.warn("CookieRefresh", "nodemailer is not installed; skipping email notification.");
		return false;
	}
	try {
		const transporter = nodemailer.createTransport({
			service: config.email.service,
			host: config.email.host,
			port: config.email.port,
			secure: config.email.secure,
			auth: config.email.auth
		});

		await transporter.sendMail({
			from: config.email.from,
			to: config.email.to,
			subject,
			text: body
		});

		return true;
	}
	catch (e) {
		app.Logger.error("CookieRefresh", {
			message: "Failed to send email notification",
			error: e.message
		});
		return false;
	}
}

function findConfigSlot (platformName, uid, currentCookie) {
	for (const platformEntry of config.accounts) {
		if (platformEntry.type !== platformName) {
			continue;
		}

		for (let i = 0; i < platformEntry.data.length; i++) {
			const dataItem = platformEntry.data[i];
			if (!dataItem || !dataItem.cookie) {
				continue;
			}

			if (dataItem.cookie === currentCookie) {
				return { platformEntry, dataIndex: i };
			}
		}
	}

	return null;
}

function setContainerCookie (uid, newCookie) {
	const account = app.HoyoLab.getAccountById(uid);
	if (!account) {
		throw new app.Error({
			message: "Account not found for cookie refresh",
			args: { uid }
		});
	}

	const oldCookie = account.cookie;
	account.cookie = newCookie;

	const platform = app.HoyoLab.get(account.platform);
	if (platform) {
		const pAccount = platform.accounts.find(i => i.uid === uid);
		if (pAccount) {
			pAccount.cookie = newCookie;
		}
	}

	if (account.configIndex !== undefined && account.configIndex !== null) {
		const slot = findConfigSlot(account.platform, uid, oldCookie);
		if (slot) {
			slot.platformEntry.data[slot.dataIndex].cookie = newCookie;
			saveConfig();
			return true;
		}
	}

	const slot = findConfigSlot(account.platform, uid, oldCookie);
	if (slot) {
		slot.platformEntry.data[slot.dataIndex].cookie = newCookie;
		saveConfig();
		return true;
	}

	app.Logger.warn("CookieRefresh", "Could not map account to config data; updated runtime only.");
	return false;
}

async function notifyCookieExpired (account) {
	const link = `${cookieRefreshBaseUrl}/cookie-refresh?platform=${encodeURIComponent(account.platform)}&uid=${encodeURIComponent(account.uid)}`;
	const message = `🚨 *Cookie expired for ${account.platform} (${account.uid})*\n\n` +
		`Please log in via the official site, obtain a fresh cookie, then POST it to:${"\n"}${link}\n\n` +
		`(You can use the web form or API call.)`;

	// Email if configured
	await sendEmailNotification(`HoyoLab Auto: Cookie expired for ${account.platform}`, message);

	// Send through platform notifications (webhook/telegram) and Discord DM if available.
	for (const platformInstance of app.Platform.list) {
		try {
			if (platformInstance.name === "webhook") {
				await platformInstance.send({
					title: "🚨 HoyoLab Auto: Cookie expired",
					description: message,
					color: 16711680
				}, { content: "Please follow the link to refresh your cookie." });
			}
			else if (platformInstance.name === "telegram") {
				await platformInstance.send(message);
			}
			else if (platformInstance.name === "discord") {
				const userId = account.discord?.userId;
				if (userId && typeof platformInstance.sendDirectMessage === "function") {
					await platformInstance.sendDirectMessage(userId, message);
				}
			}
		}
		catch (e) {
			app.Logger.warn("CookieRefresh", {
				message: "Failed to send notification on platform",
				platform: platformInstance.name,
				error: e.message
			});
		}
	}

	return link;
}

function startCookieRefreshServer () {
	const server = http.createServer(async (req, res) => {
		const parsed = new URL(req.url, `http://${req.headers.host}`);
		if (parsed.pathname === "/cookie-refresh" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html><html><body><h1>Cookie refresh</h1><p>Fill in and submit a fresh cookie for your account.</p><form method="post" action="/cookie-refresh"><input name="platform" placeholder="platform" required><br><input name="uid" placeholder="uid" required><br><textarea name="cookie" placeholder="cookie" rows="5" cols="80" required></textarea><br><button type="submit">Submit</button></form></body></html>`);
			return;
		}

		if (parsed.pathname === "/cookie-refresh" && req.method === "POST") {
			let body = "";
			req.on("data", chunk => { body += chunk; });
			req.on("end", async () => {
				let data;
				try {
					if (req.headers["content-type"]?.includes("application/json")) {
						data = JSON.parse(body);
					}
					else {
						data = Object.fromEntries(new URLSearchParams(body));
					}
				}
				catch (e) {
					res.writeHead(400);
					res.end("Invalid request body");
					return;
				}

				if (!data.platform || !data.uid || !data.cookie) {
					res.writeHead(400);
					res.end("Missing platform, uid or cookie");
					return;
				}

				try {
					setContainerCookie(data.uid, data.cookie);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						success: true,
						message: "Cookie updated successfully in memory and config file (if matched)"
					}));
				}
				catch (e) {
					res.writeHead(500);
					res.end(`Failed to set cookie: ${e.message}`);
				}
			});
			return;
		}

		if (parsed.pathname === "/status" && req.method === "GET") {
			// Format today's rewards as a single string per character
			const formattedStatus = {
				...botStatus,
				characters: botStatus.characters.map(char => ({
					...char,
					runs: char.runs.map(run => ({
						...run,
						todaySummary: {
							totalSignIns: run.todaySummary.totalSignIns,
							todaysRewards: Object.entries(run.todaySummary.todaysRewards)
								.map(([item, count]) => `${item} x${count}`)
								.join(", ")
						}
					}))
				}))
			};

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(formattedStatus, null, 2));
			return;
		}

		if (parsed.pathname === "/health" && req.method === "GET") {
			const health = {
				status: "healthy",
				timestamp: new Date().toISOString(),
				version: botStatus.version,
				platforms: app.Platform?.list?.length || 0,
				accounts: app.HoyoLab?.list?.reduce((sum, platform) => sum + platform.accounts.length, 0) || 0,
				lastUpdate: botStatus.lastUpdate
			};
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(health, null, 2));
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	});

	server.listen(cookieRefreshPort, cookieRefreshHost, () => {
		app.Logger.info("CookieRefresh", `Listening on http://${cookieRefreshHost}:${cookieRefreshPort}`);
	});

	return server;
}

(async () => {
	const start = process.hrtime.bigint();

	const platformsConfig = config.platforms;
	if (!platformsConfig || platformsConfig.length === 0) {
		console.warn("No platforms configured! Exiting.");
		process.exit(0);
	}

	globalThis.app = {
		Date,
		Error,
		RegionalTaskManager,

		Config,
		Command,

		Got: await Got.initialize(),
		Cache: new Cache(),
		Logger: new Logger(config.loglevel),
		Utils: new Utils(),
		TestNotification,
		CookieRefresh: {
			notifyCookieExpired,
			setContainerCookie,
			startServer: startCookieRefreshServer,
			updateStatus: updateBotStatus
		}
	};

	app.CookieRefresh.startServer();
	app.Logger.info("Client", "Loading configuration data");
	Config.load(config);
	app.Logger.info("Client", `Loaded ${Config.data.size} configuration entries`);

	const { loadCommands } = require("./commands/index.js");
	const commands = await loadCommands();
	await Command.importData(commands.definitions);

	const { initCrons } = require("./crons/index.js");
	initCrons();

	const accountsConfig = config.accounts;
	if (!accountsConfig || accountsConfig.length === 0) {
		app.Logger.warn("Client", "No accounts configured! Exiting.");
		process.exit(0);
	}

	const accounts = new Set();
	for (const definition of accountsConfig) {
		if (!definition.active) {
			app.Logger.warn("Client", `Skipping ${definition.type} account (inactive)`);
			continue;
		}

		accounts.add(HoyoLab.create(definition.type, definition));
	}

	const definitions = require("./gots/index.js");
	await app.Got.importData(definitions);

	globalThis.app = {
		...app,
		Platform,
		HoyoLab
	};

	const hoyoPromises = [];
	for (const account of accounts) {
		hoyoPromises.push(account.login());
	}

	await Promise.all(hoyoPromises);

	const platforms = new Set();
	for (const definition of platformsConfig) {
		if (!definition.active) {
			app.Logger.warn("Client", `Skipping ${definition.type} platform (inactive)`);
			continue;
		}

		platforms.add(Platform.create(definition.type, definition));
	}

	const promises = [];
	for (const platform of platforms) {
		promises.push(platform.connect());
	}

	await Promise.all(promises);

	// Send test notifications to confirm platform functionality
	if (config.testNotification?.enabled !== false) {
		await TestNotification.sendTestNotifications(platforms);
	}

	const end = process.hrtime.bigint();
	app.Logger.info("Client", `Initialize completed (${Number(end - start) / 1e6}ms)`);

	// Run initial check-in on startup
	app.Logger.info("Client", "Running initial check-in on startup");
	try {
		await CheckIn.code();
		app.Logger.info("Client", "Initial check-in completed");
	} catch (error) {
		app.Logger.error("Client", {
			message: "Initial check-in failed",
			error: error.message
		});
	}

	process.on("unhandledRejection", (reason) => {
		if (!(reason instanceof Error)) {
			return;
		}

		app.Logger.log("Client", {
			message: "Unhandled promise rejection",
			args: { reason }
		});
	});
})();
