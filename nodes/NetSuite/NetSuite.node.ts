import {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodePropertyOptions,
	NodeOperationError
} from 'n8n-workflow';
import * as crypto from 'crypto';

/**
 * Самые ходовые типы записей REST API. Значение — имя ресурса в URL
 * (/record/v1/{value}), поэтому регистр важен: NetSuite ожидает camelCase.
 *
 * Список намеренно курируемый, а не вытянутый из metadata-catalog: он должен
 * открываться мгновенно и без обращения к аккаунту. Всё, что сюда не попало,
 * включая кастомные записи customrecord_*, доступно через «Other».
 *
 * Порядок алфавитный — этого требует линтер n8n.
 */
const RECORD_TYPE_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Account', value: 'account' },
	{ name: 'Assembly Item', value: 'assemblyItem' },
	{ name: 'Classification', value: 'classification' },
	{ name: 'Contact', value: 'contact' },
	{ name: 'Credit Memo', value: 'creditMemo' },
	{ name: 'Currency', value: 'currency' },
	{ name: 'Customer', value: 'customer' },
	{ name: 'Customer Payment', value: 'customerPayment' },
	{ name: 'Department', value: 'department' },
	{ name: 'Employee', value: 'employee' },
	{ name: 'Estimate', value: 'estimate' },
	{ name: 'Inventory Item', value: 'inventoryItem' },
	{ name: 'Invoice', value: 'invoice' },
	{ name: 'Item Fulfillment', value: 'itemFulfillment' },
	{ name: 'Journal Entry', value: 'journalEntry' },
	{ name: 'Location', value: 'location' },
	{ name: 'Non-Inventory Sale Item', value: 'nonInventorySaleItem' },
	{ name: 'Other (Specify Below)', value: 'other' },
	{ name: 'Purchase Order', value: 'purchaseOrder' },
	{ name: 'Sales Order', value: 'salesOrder' },
	{ name: 'Service Sale Item', value: 'serviceSaleItem' },
	{ name: 'Subsidiary', value: 'subsidiary' },
	{ name: 'Vendor', value: 'vendor' },
	{ name: 'Vendor Bill', value: 'vendorBill' },
];

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
				options: RECORD_TYPE_OPTIONS,
				default: 'customer',
				description: 'The NetSuite record type to work with',
			},
			{
				displayName: 'Record Type Name',
				name: 'customResource',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'customrecord_my_record',
				description:
					'The REST resource name, exactly as NetSuite spells it. Standard records are camelCase (e.g. salesOrder); custom ones use their script ID (e.g. customrecord_my_record).',
				displayOptions: { show: { resource: ['other'] } },
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Create', value: 'create', action: 'Create a record' },
					{ name: 'Create or Update', value: 'upsert', action: 'Create or update a record' },
					{ name: 'Delete', value: 'delete', action: 'Delete a record' },
					{ name: 'Get', value: 'get', action: 'Get a record' },
					{ name: 'Update', value: 'update', action: 'Update a record' },
				],
				default: 'get',
			},
			{
				displayName: 'Record ID',
				name: 'id',
				type: 'string',
				default: '',
				required: true,
				description: 'The internal ID NetSuite assigned to the record',
				displayOptions: { show: { operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'External ID',
				name: 'externalId',
				type: 'string',
				default: '',
				required: true,
				description:
					'Your own identifier for the record. NetSuite creates the record when nothing carries this external ID yet, and updates the existing one otherwise — so re-running a workflow after a failure will not produce duplicates.',
				displayOptions: { show: { operation: ['upsert'] } },
			},
			{
				displayName: 'JSON Parameters',
				name: 'jsonParameters',
				type: 'boolean',
				default: true,
				description: 'Whether the body should be provided as JSON string',
				displayOptions: { show: { operation: ['create', 'update', 'upsert'] } },
			},
			{
				displayName: 'Body (JSON)',
				name: 'bodyJson',
				type: 'json',
				default: '{}',
				description: 'The JSON body to send',
				required: true,
				displayOptions: {
					show: { operation: ['create', 'update', 'upsert'], jsonParameters: [true] },
				},
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
			throw new NodeOperationError(
				this.getNode(),
				'NetSuite Account ID is missing in credentials. Please fill it out in the node credentials.',
			);
		}

		// Форматируем ID аккаунта для URL (заменяем все _ на - и в нижний регистр)
		const accountUrlPart = accountId.trim().toLowerCase().replace(/_/g, '-');
		const baseUrl = `https://${accountUrlPart}.suitetalk.api.netsuite.com/services/rest/record/v1`;

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const resource = this.getNodeParameter('resource', i) as string;

				// «Other» — это не тип записи, а признак того, что имя ресурса задано вручную.
				const recordType =
					resource === 'other'
						? (this.getNodeParameter('customResource', i) as string).trim()
						: resource;
				if (!recordType) {
					throw new NodeOperationError(this.getNode(), 'Record Type Name is empty', {
						itemIndex: i,
						description:
							'With Resource set to "Other" you have to spell the REST resource name yourself, e.g. customrecord_my_record.',
					});
				}

				let recordId = '';
				if (operation === 'get' || operation === 'update' || operation === 'delete') {
					recordId = this.getNodeParameter('id', i) as string;
				}

				const readBody = (): IDataObject => {
					const bodyJson = this.getNodeParameter('bodyJson', i) as string;
					return typeof bodyJson === 'string' ? JSON.parse(bodyJson) : bodyJson;
				};

				let url = `${baseUrl}/${recordType}`;
				let method: IHttpRequestMethods = 'GET';
				let body: IDataObject = {};

				if (operation === 'get') {
					method = 'GET';
					url = `${url}/${recordId}`;
				} else if (operation === 'create') {
					method = 'POST';
					body = readBody();
				} else if (operation === 'update') {
					method = 'PATCH';
					url = `${url}/${recordId}`;
					body = readBody();
				} else if (operation === 'delete') {
					method = 'DELETE';
					url = `${url}/${recordId}`;
				} else if (operation === 'upsert') {
					const externalId = (this.getNodeParameter('externalId', i) as string).trim();
					if (!externalId) {
						throw new NodeOperationError(this.getNode(), 'External ID is empty', {
							itemIndex: i,
							description:
								'Upsert addresses the record by external ID, so it cannot be left blank. Use Create if the record has no external ID.',
						});
					}
					// PUT на eid:{externalId} — создаст запись, если такой ещё нет, иначе обновит.
					method = 'PUT';
					url = `${url}/eid:${encodeURIComponent(externalId)}`;
					body = readBody();
				}

				const options: IHttpRequestOptions = {
					method,
					url,
					headers: {
						'Content-Type': 'application/json',
					},
					// NetSuite отклоняет GET и DELETE с телом — шлём его только там, где он есть.
					...(method === 'GET' || method === 'DELETE' ? {} : { body }),
					json: true,
					// На POST/PATCH/PUT/DELETE NetSuite отвечает пустым 204, а внутренний ID
					// затронутой записи кладёт в заголовок Location. Без полного ответа он
					// теряется, и следующая нода не знает, что именно было создано.
					returnFullResponse: true,
				};

				let response;
				if (authentication === 'tba') {
					// OAuth 1.0a: каждый запрос подписывается локально.
					options.headers!['Authorization'] = generateNetSuiteOAuthHeader(method, url, credentials as any);
					response = await this.helpers.httpRequest.call(this, options);
				} else {
					// OAuth 2.0: n8n сам добавит Bearer из credential и обновит токен по 401.
					response = await this.helpers.httpRequestWithAuthentication.call(this, 'netSuiteOAuth2Api', options);
				}

				const responseBody = response?.body;
				const responseHeaders = (response?.headers ?? {}) as Record<string, unknown>;

				let json: IDataObject;
				if (typeof responseBody === 'string' && responseBody.length > 0) {
					json = { data: responseBody };
				} else if (responseBody && typeof responseBody === 'object' && Object.keys(responseBody).length > 0) {
					json = responseBody as IDataObject;
				} else {
					json = { success: true };
					// Location выглядит как .../record/v1/customer/12345 — нас интересует хвост.
					const location = (responseHeaders.location ?? responseHeaders.Location) as string | undefined;
					const idFromLocation = location?.split('/').filter(Boolean).pop();
					const id = idFromLocation ?? (recordId || undefined);
					if (id) {
						json.id = id;
					}
				}
				returnData.push({ json });
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