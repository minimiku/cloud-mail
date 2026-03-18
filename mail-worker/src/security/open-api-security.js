import app from '../hono/hono';
import BizError from '../error/biz-error';
import settingService from '../service/setting-service';
import { t } from '../i18n/i18n';

function getApiKey(c) {
	const apiKey = c.req.header('x-api-key');

	if (apiKey) {
		return apiKey.trim();
	}

	const authorization = c.req.header('Authorization');

	if (!authorization) {
		return '';
	}

	if (authorization.startsWith('Bearer ')) {
		return authorization.slice(7).trim();
	}

	return authorization.trim();
}

app.use('/openApi/*', async (c, next) => {
	const { openApiKey } = await settingService.query(c);

	if (!openApiKey) {
		throw new BizError(t('openApiDisabled'), 403);
	}

	if (getApiKey(c) !== openApiKey) {
		throw new BizError(t('openApiKeyFail'), 401);
	}

	return await next();
});
