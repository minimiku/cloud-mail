import app from '../hono/hono';
import result from '../model/result';
import openApiService from '../service/open-api-service';

app.post('/openApi/mailbox/create', async (c) => {
	const data = await openApiService.createMailbox(c, await c.req.json());
	return c.json(result.ok(data));
});

app.get('/openApi/mailbox/emailList', async (c) => {
	const data = await openApiService.mailboxEmailList(c, c.req.query());
	return c.json(result.ok(data));
});

app.get('/openApi/mailbox/emailContent', async (c) => {
	const data = await openApiService.mailboxEmailContent(c, c.req.query());
	return c.json(result.ok(data));
});
