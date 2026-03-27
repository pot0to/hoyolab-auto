module.exports = {
	name: "update-cookie",
	expression: "0 */2 * * *",
	description: "Update cookie for all accounts",
	code: (async function updateCookie () {
		// eslint-disable-next-line object-curly-spacing
		const accounts = app.HoyoLab.getActiveAccounts({ blacklist: ["honkai", "tot"] });
		if (accounts.length === 0) {
			return;
		}

		for (const account of accounts) {
			const platform = app.HoyoLab.get(account.platform);
			const refreshCookie = await platform.updateCookie(account);
			if (!refreshCookie) {
				continue;
			}

			if (!refreshCookie.success) {
				if (refreshCookie.isExpired) {
					account.cookieExpired = true;
					app.Logger.warn("Cron:UpdateCookie", `${account.platform} account ${account.uid} cookie is expired or invalid. Please re-obtain a fresh cookie (see latest cookie guide) and update config.`);
					if (app.CookieRefresh && typeof app.CookieRefresh.notifyCookieExpired === "function") {
						await app.CookieRefresh.notifyCookieExpired(account);
					}
					if (app.CookieRefresh && typeof app.CookieRefresh.updateStatus === "function") {
						app.CookieRefresh.updateStatus('cookieExpired', {
							uid: account.uid,
							platform: account.platform
						});
					}
				}
				continue;
			}

			// Cookie is valid
			if (app.CookieRefresh && typeof app.CookieRefresh.updateStatus === "function") {
				app.CookieRefresh.updateStatus('cookieValid', {
					uid: account.uid,
					platform: account.platform
				});
			}

			const cookieData = app.HoyoLab.parseCookie(account.cookie, {
				blacklist: ["cookie_token", "account_id"]
			});

			const { accountId, token } = refreshCookie.data;
			account.cookie = `${cookieData}; cookie_token=${token}; account_id=${accountId}`;
			platform.update(account);
		}

		app.Logger.debug("Cron:UpdateCookie", "Updated cookie for all accounts");
	})
};
