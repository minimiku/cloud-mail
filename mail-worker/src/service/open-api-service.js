import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
import BizError from '../error/biz-error';
import orm from '../entity/orm';
import email from '../entity/email';
import account from '../entity/account';
import user from '../entity/user';
import { emailConst, isDel } from '../const/entity-const';
import { t } from '../i18n/i18n';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import roleService from './role-service';
import accountService from './account-service';
import userService from './user-service';
import settingService from './setting-service';
import cryptoUtils from '../utils/crypto-utils';
import domainUtils from '../utils/domain-uitls';
import emailService from './email-service';

const openApiService = {

	async createMailbox(c, params) {
		const { minEmailPrefix, emailPrefixFilter, openApiDomainList, domainList } = await settingService.query(c);
		const roleRow = await roleService.selectDefaultRole(c);
		const mailbox = this.resolveMailbox(params);
		const password = params.password?.trim() || cryptoUtils.genRandomToken(16);
		const allowedDomains = this.getAllowedDomains(openApiDomainList, domainList);

		if (!mailbox) {
			throw new BizError(t('emptyEmail'));
		}

		if (!verifyUtils.isEmail(mailbox)) {
			throw new BizError(t('notEmail'));
		}

		if (!allowedDomains.includes(emailUtils.getDomain(mailbox))) {
			throw new BizError(t('notEmailDomain'));
		}

		if (emailUtils.getName(mailbox).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix }));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(mailbox).includes(content))) {
			throw new BizError(t('banEmailPrefix'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		if (!roleService.hasAvailDomainPerm(roleRow.availDomain, mailbox)) {
			throw new BizError(t('noDomainPermReg'));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, mailbox);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		const { salt, hash } = await cryptoUtils.hashPassword(password);
		const userId = await userService.insert(c, {
			email: mailbox,
			password: hash,
			salt,
			type: roleRow.roleId
		});

		await userService.updateUserInfo(c, userId, true);

		const mailboxRow = await orm(c).insert(account).values({
			userId,
			email: mailbox,
			name: emailUtils.getName(mailbox)
		}).returning().get();

		const userRow = await userService.selectById(c, userId);

		return {
			userId,
			accountId: mailboxRow.accountId,
			email: mailbox,
			prefix: emailUtils.getName(mailbox),
			domain: emailUtils.getDomain(mailbox),
			password,
			roleId: roleRow.roleId,
			roleName: roleRow.name,
			createTime: userRow?.createTime || mailboxRow.createTime
		};
	},

	async mailboxEmailList(c, params) {
		const mailboxRow = await this.getMailbox(c, params.email);
		const page = this.toPage(params.page);
		const size = this.toSize(params.size);
		const offset = (page - 1) * size;

		const [list, totalRow] = await Promise.all([
			orm(c)
				.select({
					emailId: email.emailId,
					subject: email.subject,
					sendEmail: email.sendEmail,
					sendName: email.name,
					toEmail: email.toEmail,
					toName: email.toName,
					status: email.status,
					unread: email.unread,
					createTime: email.createTime
				})
				.from(email)
				.where(and(
					eq(email.accountId, mailboxRow.accountId),
					eq(email.type, emailConst.type.RECEIVE),
					eq(email.isDel, isDel.NORMAL),
					ne(email.status, emailConst.status.SAVING)
				))
				.orderBy(desc(email.emailId))
				.limit(size)
				.offset(offset)
				.all(),
			orm(c)
				.select({ total: count() })
				.from(email)
				.where(and(
					eq(email.accountId, mailboxRow.accountId),
					eq(email.type, emailConst.type.RECEIVE),
					eq(email.isDel, isDel.NORMAL),
					ne(email.status, emailConst.status.SAVING)
				))
				.get()
		]);

		await emailService.emailAddAtt(c, list);

		return {
			email: mailboxRow.email,
			accountId: mailboxRow.accountId,
			page,
			size,
			total: totalRow.total,
			list: list.map(row => ({
				...row,
				attCount: row.attList?.length || 0,
				hasAttachment: (row.attList?.length || 0) > 0,
				attList: undefined
			})).map(({ attList, ...row }) => row)
		};
	},

	async mailboxEmailContent(c, params) {
		const mailboxRow = await this.getMailbox(c, params.email);
		const emailId = Number(params.emailId);

		if (!emailId) {
			throw new BizError(t('notExistMailboxEmail'));
		}

		const emailRow = await orm(c).select().from(email).where(and(
			eq(email.emailId, emailId),
			eq(email.accountId, mailboxRow.accountId),
			eq(email.type, emailConst.type.RECEIVE),
			eq(email.isDel, isDel.NORMAL),
			ne(email.status, emailConst.status.SAVING)
		)).get();

		if (!emailRow) {
			throw new BizError(t('notExistMailboxEmail'));
		}

		await emailService.emailAddAtt(c, [emailRow]);

		const { r2Domain } = await settingService.query(c);
		const ossDomain = domainUtils.toOssDomain(r2Domain);
		const recipientList = this.parseRecipient(emailRow.recipient);

		return {
			email: mailboxRow.email,
			emailId: emailRow.emailId,
			subject: emailRow.subject,
			sendEmail: emailRow.sendEmail,
			sendName: emailRow.name,
			toEmail: emailRow.toEmail,
			toName: emailRow.toName,
			status: emailRow.status,
			unread: emailRow.unread,
			createTime: emailRow.createTime,
			text: emailRow.text,
			content: this.formatContent(emailRow.content, ossDomain),
			recipient: recipientList,
			attList: (emailRow.attList || []).map(attRow => ({
				attId: attRow.attId,
				filename: attRow.filename,
				mimeType: attRow.mimeType,
				size: attRow.size,
				key: attRow.key,
				url: ossDomain ? `${ossDomain}/${attRow.key}` : attRow.key
			}))
		};
	},

	async getMailbox(c, mailbox) {
		const mailboxValue = mailbox?.trim();

		if (!mailboxValue) {
			throw new BizError(t('emptyEmail'));
		}

		if (!verifyUtils.isEmail(mailboxValue)) {
			throw new BizError(t('notEmail'));
		}

		const mailboxRow = await orm(c).select({
			accountId: account.accountId,
			email: account.email,
			userId: account.userId,
			accountIsDel: account.isDel,
			userIsDel: user.isDel
		}).from(account)
			.leftJoin(user, eq(user.userId, account.userId))
			.where(sql`${account.email} COLLATE NOCASE = ${mailboxValue}`)
			.get();

		if (!mailboxRow || mailboxRow.accountIsDel === isDel.DELETE || mailboxRow.userIsDel === isDel.DELETE) {
			throw new BizError(t('notExistMailbox'));
		}

		return mailboxRow;
	},

	toPage(page) {
		const value = Number(page);
		return Number.isNaN(value) || value < 1 ? 1 : value;
	},

	toSize(size) {
		const value = Number(size);

		if (Number.isNaN(value) || value < 1) {
			return 20;
		}

		return value > 100 ? 100 : value;
	},

	parseRecipient(recipient) {
		try {
			const list = JSON.parse(recipient || '[]');
			return Array.isArray(list) ? list : [];
		} catch (e) {
			return [];
		}
	},

	resolveMailbox(params) {
		const email = params.email?.trim();
		const prefix = params.prefix?.trim();
		const domain = params.domain?.replace(/^@/, '').trim();

		if (email) {
			return email;
		}

		if (!prefix || !domain) {
			return '';
		}

		return `${prefix}@${domain}`;
	},

	getAllowedDomains(openApiDomainList, domainList) {
		const configuredDomains = (openApiDomainList || [])
			.map(item => item.replace(/^@/, '').trim())
			.filter(Boolean);

		if (configuredDomains.length > 0) {
			return configuredDomains;
		}

		return (domainList || [])
			.map(item => item.replace(/^@/, '').trim())
			.filter(Boolean);
	},

	formatContent(content, ossDomain) {
		if (!content || !ossDomain) {
			return content || '';
		}

		return content.replace(/{{domain}}/g, `${ossDomain}/`);
	}
};

export default openApiService;
