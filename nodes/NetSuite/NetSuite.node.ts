import {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodePropertyOptions,
	JsonObject,
	NodeApiError,
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

/**
 * «subsidiary.id» превращается в { subsidiary: { id: ... } }. Ссылки в NetSuite —
 * всегда вложенный объект с id, и без точки их из плоского списка полей не задать.
 */
function setByPath(target: IDataObject, path: string[], value: unknown): void {
	let cursor = target;
	for (let p = 0; p < path.length - 1; p++) {
		const key = path[p];
		if (typeof cursor[key] !== 'object' || cursor[key] === null) {
			cursor[key] = {};
		}
		cursor = cursor[key] as IDataObject;
	}
	cursor[path[path.length - 1]] = value as IDataObject[string];
}

/**
 * Объекты и массивы в списке полей пишутся JSON-ом — иначе не задать sublist.
 * true/false/null распознаём: чекбокс строку не примет, а null — единственный способ
 * очистить поле при update. Числа намеренно оставляем строками: в NetSuite '1' и
 * '00123' сплошь и рядом ID, и молчаливое приведение к числу их ломает.
 */
function parseFieldValue(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw;
	const trimmed = raw.trim();
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	if (trimmed === 'null') return null;
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return raw;
		}
	}
	return raw;
}

/**
 * NetSuite отвечает на неудачную запись телом в формате RFC 7807: title/status и
 * массив o:errorDetails, где и лежит настоящая причина («You must specify companyname»).
 * n8n без этого показывает только «400 - Bad Request», и подбор body превращается
 * в угадайку. Обёртка вокруг ошибки зависит от версии n8n и от того, какой helper её
 * бросил, поэтому payload ищем по нескольким местам, а не по одному.
 */
function extractNetSuiteError(error: unknown): IDataObject | undefined {
	const dig = (root: unknown, ...path: string[]): unknown => {
		let cursor = root;
		for (const key of path) {
			if (!cursor || typeof cursor !== 'object') return undefined;
			cursor = (cursor as Record<string, unknown>)[key];
		}
		return cursor;
	};

	const candidates = [
		dig(error, 'response', 'data'),
		dig(error, 'response', 'body'),
		dig(error, 'error'),
		dig(error, 'body'),
		dig(error, 'cause', 'response', 'data'),
		dig(error, 'cause', 'response', 'body'),
		dig(error, 'cause', 'error'),
		dig(error, 'cause'),
	];

	for (const candidate of candidates) {
		let payload: unknown = candidate;
		if (typeof payload === 'string') {
			try {
				payload = JSON.parse(payload);
			} catch {
				continue;
			}
		}
		if (payload && typeof payload === 'object' && ('o:errorDetails' in payload || 'title' in payload)) {
			return payload as IDataObject;
		}
	}

	return undefined;
}

/** Собирает из o:errorDetails человекочитаемое сообщение и код для description. */
function describeNetSuiteError(payload: IDataObject): { message: string; description?: string } {
	const details = payload['o:errorDetails'];

	if (Array.isArray(details) && details.length > 0) {
		const messages = details
			.map((entry) => {
				const detail = (entry as IDataObject)?.detail;
				const path = (entry as IDataObject)?.['o:errorPath'];
				if (!detail) return '';
				return path ? `${path}: ${detail}` : String(detail);
			})
			.filter(Boolean);

		if (messages.length > 0) {
			const codes = [
				...new Set(details.map((entry) => (entry as IDataObject)?.['o:errorCode']).filter(Boolean)),
			];
			return {
				message: messages.join('; '),
				description: codes.length > 0 ? `NetSuite error code: ${codes.join(', ')}` : undefined,
			};
		}
	}

	const title = payload.title;
	return { message: typeof title === 'string' && title ? title : 'NetSuite request failed' };
}

function percentEncode(str: string): string {
	return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface NetSuiteTbaCredentials {
	realm: string;
	consumerKey: string;
	consumerSecret: string;
	token: string;
	tokenSecret: string;
	signatureMethod: string;
}

export function generateNetSuiteOAuthHeader(
	method: string,
	url: string,
	credentials: NetSuiteTbaCredentials,
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
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				placeholder: 'Add Field',
				default: {},
				description: 'The record fields to write',
				displayOptions: {
					show: { operation: ['create', 'update', 'upsert'], jsonParameters: [false] },
				},
				options: [
					{
						name: 'field',
						displayName: 'Field',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								required: true,
								placeholder: 'companyName',
								description:
									'The NetSuite field ID. A dotted name builds a nested object, which is how reference fields such as subsidiary are written.',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description:
									'The value to write. Exactly true, false or null is sent as that literal, a value starting with { or [ is parsed as JSON so sublists stay possible, and everything else is sent as a string — including numbers, because NetSuite internal IDs are strings.',
							},
						],
					},
				],
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
					if (this.getNodeParameter('jsonParameters', i, true) as boolean) {
						const bodyJson = this.getNodeParameter('bodyJson', i) as string;
						if (typeof bodyJson !== 'string') return bodyJson;
						try {
							return JSON.parse(bodyJson);
						} catch (parseError) {
							throw new NodeOperationError(this.getNode(), 'Body (JSON) is not valid JSON', {
								itemIndex: i,
								description: (parseError as Error).message,
							});
						}
					}

					const collection = this.getNodeParameter('fields', i, {}) as IDataObject;
					const entries = (collection.field ?? []) as Array<IDataObject>;
					const built: IDataObject = {};
					for (const entry of entries) {
						const name = String(entry?.name ?? '').trim();
						if (!name) continue;
						setByPath(built, name.split('.'), parseFieldValue(entry.value));
					}
					return built;
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
					options.headers!['Authorization'] = generateNetSuiteOAuthHeader(
						method,
						url,
						credentials as unknown as NetSuiteTbaCredentials,
					);
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
				returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				// Свои проверки уже сформулированы по-человечески — их не переписываем.
				const payload = error instanceof NodeOperationError ? undefined : extractNetSuiteError(error);
				let failure = error;
				if (payload) {
					const { message, description } = describeNetSuiteError(payload);
					const status = payload.status;
					failure = new NodeApiError(this.getNode(), payload as JsonObject, {
						message,
						description,
						httpCode: status === undefined ? undefined : String(status),
						itemIndex: i,
					});
				}

				if (this.continueOnFail()) {
					returnData.push({ json: { error: failure.message }, pairedItem: { item: i } });
					continue;
				}
				throw failure;
			}
		}

		return [returnData];
	}
}