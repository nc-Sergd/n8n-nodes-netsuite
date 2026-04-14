import {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	IExecuteFunctions
} from 'n8n-workflow';
import * as crypto from 'crypto';

function percentEncode(str: string): string {
	return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function generateNetSuiteOAuthHeader(
	method: string,
	url: string,
	credentials: { realm: string; consumerKey: string; consumerSecret: string; token: string; tokenSecret: string },
) {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const nonce = crypto.randomBytes(11).toString('hex');

	const oauthParams: Record<string, string> = {
		oauth_consumer_key: credentials.consumerKey,
		oauth_nonce: nonce,
		oauth_signature_method: 'HMAC-SHA256',
		oauth_timestamp: timestamp,
		oauth_token: credentials.token,
		oauth_version: '1.0',
	};

	const sortedKeys = Object.keys(oauthParams).sort();
	const parameterString = sortedKeys
		.map((key) => `${percentEncode(key)}=${percentEncode(oauthParams[key])}`)
		.join('&');

	const signatureBaseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(parameterString)}`;
	const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`;
	const signature = crypto.createHmac('sha256', signingKey).update(signatureBaseString).digest('base64');

	let authHeader = `OAuth realm="${credentials.realm}",`;
	authHeader += `oauth_consumer_key="${percentEncode(credentials.consumerKey)}",`;
	authHeader += `oauth_token="${percentEncode(credentials.token)}",`;
	authHeader += `oauth_signature_method="HMAC-SHA256",`;
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
			}
		],
		properties: [
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
				],
				default: 'get',
			},
			{
				displayName: 'Record ID',
				name: 'id',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['get'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('netSuiteApi');

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const recordId = this.getNodeParameter('id', i) as string;

				const realm = credentials.realm as string;
				if (!realm) {
					throw new Error('NetSuite Account ID (realm) is missing in credentials. Please fill it out in the node credentials.');
				}

				// Форматируем ID аккаунта для URL (заменяем все _ на - и в нижний регистр)
				const accountUrlPart = realm.toLowerCase().replace(/_/g, '-');
				const baseUrl = `https://${accountUrlPart}.suitetalk.api.netsuite.com/services/rest/record/v1`;

				const url = `${baseUrl}/${resource}/${recordId}`;
				const method = 'GET';
				const authHeader = generateNetSuiteOAuthHeader(method, url, credentials as any);
				console.log('--- NetSuite OAuth Header ---');
				console.log(authHeader);

				const options: IHttpRequestOptions = {
					method,
					url,
					headers: {
						'Content-Type': 'application/json',
						'Authorization': authHeader,
					},
				};

				// Важно: n8n автоматически использует данные из credentials 'netSuiteApi'
				// если они настроены в описании ноды.
				const responseData = await this.helpers.httpRequest.call(this, options);
				returnData.push({ json: responseData as IDataObject });
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