import {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	IExecuteFunctions,
	IHttpRequestMethods
} from 'n8n-workflow';
import * as crypto from 'crypto';

function percentEncode(str: string): string {
	return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function generateNetSuiteOAuthHeader(
	method: string,
	url: string,
	credentials: { realm: string; consumerKey: string; consumerSecret: string; token: string; tokenSecret: string, signatureMethod: string },
) {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const nonce = crypto.randomBytes(11).toString('hex');

	const oauthParams: Record<string, string> = {
		oauth_consumer_key: credentials.consumerKey,
		oauth_nonce: nonce,
		oauth_signature_method: credentials.signatureMethod,
		oauth_timestamp: timestamp,
		oauth_token: credentials.token,
		oauth_version: '1.0',
	};

	const parsed = new URL(url);

	// RFC 5849 §3.4.1.2: в base string URI не входит query — только схема, хост и путь.
	// Схема и хост приводятся к нижнему регистру, порт по умолчанию опускается.
	const baseUri = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}`;

	// §3.4.1.3.1: параметры запроса подписываются вместе с oauth_*. NetSuite пересобирает
	// base string у себя, поэтому пропуск query даёт INVALID_LOGIN_ATTEMPT — при этом
	// заголовок Authorization выглядит корректным и причину по нему не видно.
	// Тело не добавляем: оно у нас всегда JSON, а §3.4.1.3.1 требует учитывать
	// только application/x-www-form-urlencoded.
	const params: Array<[string, string]> = Object.entries(oauthParams);
	parsed.searchParams.forEach((value, key) => params.push([key, value]));

	// §3.4.1.3.2: сортировка по закодированному ключу, при совпадении — по значению.
	const parameterString = params
		.map(([key, value]): [string, string] => [percentEncode(key), percentEncode(value)])
		.sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join('&');

	const signatureBaseString = `${method.toUpperCase()}&${percentEncode(baseUri)}&${percentEncode(parameterString)}`;
	const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`;
	const signature = crypto.createHmac('sha256', signingKey).update(signatureBaseString).digest('base64');

	let authHeader = `OAuth realm="${credentials.realm}",`;
	authHeader += `oauth_consumer_key="${percentEncode(credentials.consumerKey)}",`;
	authHeader += `oauth_token="${percentEncode(credentials.token)}",`;
	authHeader += `oauth_signature_method="${credentials.signatureMethod}",`;
	authHeader += `oauth_timestamp="${timestamp}",`;
	authHeader += `oauth_nonce="${nonce}",`;
	authHeader += `oauth_version="1.0",`;
	authHeader += `oauth_signature="${percentEncode(signature)}"`;

	return authHeader;
}

export class NetSuite implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'NetSuite',
		name: 'netSuite',
		icon: 'file:../../icons/netsuite.svg',
		group: ['transform'],
		version: 1,
		description: 'Interact with NetSuite REST API',
		defaults: { name: 'NetSuite' },
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		credentials: [
			{
				name: 'netSuiteApi',
				required: true,
				displayOptions: { show: { authentication: ['tba'] } },
			},
			{
				name: 'netSuiteOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['oAuth2'] } },
			}
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'OAuth 2.0 (Client Credentials)', value: 'oAuth2' },
					{ name: 'Token-Based Authentication (OAuth 1.0a)', value: 'tba' },
				],
				default: 'oAuth2',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Customer', value: 'customer' },
					{ name: 'Invoice', value: 'invoice' },
				],
				default: 'customer',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Get', value: 'get' },
					{ name: 'Create', value: 'create' },
					{ name: 'Update', value: 'update' },
				],
				default: 'get',
			},
			{
				displayName: 'Record ID',
				name: 'id',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['get', 'update'] } },
			},
			{
				displayName: 'JSON Parameters',
				name: 'jsonParameters',
				type: 'boolean',
				default: true,
				description: 'Whether the body should be provided as JSON string',
				displayOptions: { show: { operation: ['create', 'update'] } },
			},
			{
				displayName: 'Body (JSON)',
				name: 'bodyJson',
				type: 'json',
				default: '{}',
				description: 'The JSON body to send',
				required: true,
				displayOptions: { show: { operation: ['create', 'update'], jsonParameters: [true] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const authentication = this.getNodeParameter('authentication', 0, 'oAuth2') as 'oAuth2' | 'tba';
		const credentialName = authentication === 'tba' ? 'netSuiteApi' : 'netSuiteOAuth2Api';
		const credentials = await this.getCredentials(credentialName);

		// TBA calls it "realm", OAuth 2.0 calls it "accountId" — same value.
		const accountId = (authentication === 'tba' ? credentials.realm : credentials.accountId) as string;
		if (!accountId) {
			throw new Error('NetSuite Account ID is missing in credentials. Please fill it out in the node credentials.');
		}

		// Форматируем ID аккаунта для URL (заменяем все _ на - и в нижний регистр)
		const accountUrlPart = accountId.trim().toLowerCase().replace(/_/g, '-');
		const baseUrl = `https://${accountUrlPart}.suitetalk.api.netsuite.com/services/rest/record/v1`;

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const resource = this.getNodeParameter('resource', i) as string;

				let recordId = '';
				if (operation === 'get' || operation === 'update') {
					recordId = this.getNodeParameter('id', i) as string;
				}

				let url = `${baseUrl}/${resource}`;
				let method: IHttpRequestMethods = 'GET';
				let body: IDataObject = {};

				if (operation === 'get') {
					method = 'GET';
					url = `${url}/${recordId}`;
				} else if (operation === 'create') {
					method = 'POST';
					const bodyJson = this.getNodeParameter('bodyJson', i) as string;
					body = typeof bodyJson === 'string' ? JSON.parse(bodyJson) : bodyJson;
				} else if (operation === 'update') {
					method = 'PATCH';
					url = `${url}/${recordId}`;
					const bodyJson = this.getNodeParameter('bodyJson', i) as string;
					body = typeof bodyJson === 'string' ? JSON.parse(bodyJson) : bodyJson;
				}

				const options: IHttpRequestOptions = {
					method,
					url,
					headers: {
						'Content-Type': 'application/json',
					},
					// NetSuite отклоняет GET с телом — отправляем body только там, где он есть.
					...(method === 'GET' ? {} : { body }),
					json: true,
				};

				let responseData;
				if (authentication === 'tba') {
					// OAuth 1.0a: каждый запрос подписывается локально.
					options.headers!['Authorization'] = generateNetSuiteOAuthHeader(method, url, credentials as any);
					responseData = await this.helpers.httpRequest.call(this, options);
				} else {
					// OAuth 2.0: n8n сам добавит Bearer из credential и обновит токен по 401.
					responseData = await this.helpers.httpRequestWithAuthentication.call(this, 'netSuiteOAuth2Api', options);
				}
				responseData = responseData || { success: true };
				returnData.push({ json: (typeof responseData === 'string' ? { data: responseData } : responseData) as IDataObject });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: error.message } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}