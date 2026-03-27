module.exports = {
	name: "check-in",
	expression: "0 0 0 * * *",
	description: "Run daily check-in every day at midnight or your specified time",
	code: (async function checkIn () {
		const accounts = app.HoyoLab.getActiveAccounts();
		if (accounts.length === 0) {
			app.Logger.warn("Cron:CheckIn", "No active accounts found for HoyoLab");
			return;
		}

		const messages = [];
		const allAccountData = [];
		const activeGameAccounts = app.HoyoLab.getActivePlatform();
		for (const name of activeGameAccounts) {
			const platform = app.HoyoLab.get(name);
			const execution = await platform.checkIn();
			
			// Always capture all account data for JSON, even if check-in already happened
			allAccountData.push(...execution);
			
			// Only add to messages for notifications if there are results
			if (execution.length === 0) {
				app.Logger.info("Cron:CheckIn", `All accounts for ${name} either signed in or failed to sign in`);
				continue;
			}

			messages.push(...execution);
		}

		if (messages.length === 0 && allAccountData.length === 0) {
			app.Logger.info("Cron:CheckIn", "No accounts to run check-in for");
			return;
		}

		// --- Notification Loop (Fixed Duplication) ---
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];

			// Discord Webhook
			const webhook = app.Platform.get(3);
			if (webhook) {
				let fields = [
					{ name: "UID", value: message.uid, inline: true },
					{ name: "Username", value: message.username, inline: true },
					{ name: "Region", value: message.region, inline: true },
					{ name: "Rank", value: message.rank, inline: true },
					{ name: "Today's Reward", value: `${message.award.name} x${message.award.count}`, inline: true },
					{ name: "Total Sign-ins", value: message.total, inline: true },
					{ name: "Result", value: message.result, inline: true }
				];

				if (message.platform === "tot") {
					fields = fields.filter(f => f.name !== "Username" && f.name !== "Rank");
				}

				const embed = {
					color: message.assets.color,
					title: message.assets.game,
					author: {
						name: message.assets.author,
						icon_url: message.assets.logo
					},
					thumbnail: {
						url: message.award.icon
					},
					fields,
					timestamp: new Date(),
					footer: {
						text: `HoyoLab Auto Check-In (${i + 1}/${messages.length}) Executed`,
						icon_url: message.assets.logo
					}
				};

				await webhook.send(embed, {
					author: message.assets.author,
					icon: message.assets.logo
				});
			}

			// Telegram
			const telegram = app.Platform.get(2);
			if (telegram) {
				const messageText = [
					`🎮 **${message.assets.game}** Daily Check-In`,
					`🆔 **(${message.uid})** ${message.username}`,
					`🌍 **Region:** ${message.region}`,
					`🏆 **Rank:** ${message.rank}`,
					`🎁 **Today's Reward:** ${message.award.name} x${message.award.count}`,
					`📅 **Total Sign-ins:** ${message.total}`,
					`📝 **Result:** ${message.result}`
				].join("\n");

				const escapedMessage = app.Utils.escapeCharacters(messageText);
				await telegram.send(escapedMessage);
			}
		}

		// --- Bot Status Update ---
		if (app.CookieRefresh && typeof app.CookieRefresh.updateStatus === "function") {
			app.CookieRefresh.updateStatus('checkIn', {
				totalAccounts: allAccountData.length,
				results: allAccountData.map(msg => ({
					uid: msg.uid,
					platform: msg.platform,
					username: msg.username,
					region: msg.region,
					rewardName: msg.award.name,
					rewardCount: msg.award.count,
					reward: `${msg.award.name} x${msg.award.count}`,
					totalSignIns: msg.total,
					result: msg.result,
					timestamp: new Date().toISOString()
				}))
			});
		}
	})
};