const config = require("./config");

class UrlFactory {
	static async getAuthenticationUrl() {
		const authenticationOptions = config.authenticationOptions;

		return authenticationOptions.protocol + `://` + authenticationOptions.ip + `:` + authenticationOptions.port + authenticationOptions.rootPath + authenticationOptions.api;
	}
}

module.exports = UrlFactory;