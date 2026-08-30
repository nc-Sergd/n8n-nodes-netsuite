import {
	IAuthenticateGeneric,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IDataObject,
	IHttpRequestHelper,
	INodeProperties,
	Icon,
} from 'n8n-workflow';
import { constants as cryptoConstants, sign as cryptoSign } from 'crypto';

type SigningAlgorithm = 'ES256' | 'ES384' | 'ES512' | 'RS256' | 'PS256';

const DIGEST_BY_ALGORITHM: Record<SigningAlgorithm, string> = {
	ES256: 'sha256',
	ES384: 'sha384',
	ES512: 'sha512',
	RS256: 'sha256',
	PS256: 'sha256',
};

/**
 * Builds the SuiteTalk host from an account id: 1234567_SB1 -> 1234567-sb1
 */
export function toAccountDomain(accountId: string): string {
	return (accountId ?? '').trim().toLowerCase().replace(/_/g, '-');
}

export function tokenUrlFor(accountId: string): string {
	return `https://${toAccountDomain(accountId)}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
}

/**
 * Accepts a PEM pasted either as real multi-line text or with escaped "\n" sequences.
 */
function normalizePrivateKey(privateKey: string): string {
	return (privateKey ?? '').replace(/\\n/g, '\n').trim();
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString('base64url');
}

function signJwt(
	algorithm: SigningAlgorithm,
	header: IDataObject,
	payload: IDataObject,
	privateKey: string,
): string {
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

	const keyOptions: Record<string, unknown> = { key: privateKey };
	if (algorithm.startsWith('ES')) {
		// JWS requires the raw R||S form; Node emits DER unless told otherwise.
		keyOptions.dsaEncoding = 'ieee-p1363';
	}
	if (algorithm === 'PS256') {
		keyOptions.padding = cryptoConstants.RSA_PKCS1_PSS_PADDING;
		keyOptions.saltLength = cryptoConstants.RSA_PSS_SALTLEN_DIGEST;
	}

	const signature = cryptoSign(
		DIGEST_BY_ALGORITHM[algorithm],
		Buffer.from(signingInput),
		keyOptions as never,
	);

	return `${signingInput}.${base64url(signature)}`;
}

export class NetSuiteOAuth2Api implements ICredentialType {
	name = 'netSuiteOAuth2Api';

	displayName = 'NetSuite OAuth 2.0 (Client Credentials)';

	documentationUrl =
		'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_162686838198.html';

	icon: Icon = 'file:../icons/netsuite.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'Account ID',
			name: 'accountId',
			type: 'string',
			default: '',
			required: true,
			placeholder: '1234567_SB1',
			description:
				'Your account ID including the suffix, written with an underscore (e.g. 1234567_SB1). It is lower-cased and the underscore turned into a dash to build the API host.',
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			description:
				'Consumer Key / Client ID from the Integration record (Setup > Integration > Manage Integrations)',
		},
		{
			displayName: 'Certificate ID',
			name: 'certificateId',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true },
			description:
				'Certificate ID shown in Setup > Integration > OAuth 2.0 Client Credentials (M2M) Setup. Sent as the JWT "kid" header.',
		},
		{
			displayName: 'Private Key',
			name: 'privateKey',
			type: 'string',
			default: '',
			required: true,
			typeOptions: { password: true, rows: 10 },
			placeholder: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
			description:
				'PEM private key matching the certificate uploaded to NetSuite. Real line breaks or escaped \\n both work.',
		},
		{
			displayName: 'Signature Algorithm',
			name: 'algorithm',
			type: 'options',
			default: 'ES512',
			description: 'Must match the key type of the uploaded certificate',
			options: [
				{ name: 'ES512 (EC secp521r1)', value: 'ES512' },
				{ name: 'ES384 (EC secp384r1)', value: 'ES384' },
				{ name: 'ES256 (EC prime256v1)', value: 'ES256' },
				{ name: 'PS256 (RSA)', value: 'PS256' },
				{ name: 'RS256 (RSA)', value: 'RS256' },
			],
		},
		{
			displayName: 'Scopes',
			name: 'scopes',
			type: 'multiOptions',
			default: ['rest_webservices'],
			description: 'Must be a subset of the scopes enabled on the Integration record',
			options: [
				{ name: 'REST Web Services', value: 'rest_webservices' },
				{ name: 'RESTlets', value: 'restlets' },
				{ name: 'SuiteAnalytics Connect', value: 'suite_analytics' },
			],
		},
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'hidden',
			default: '',
			// Tells n8n this value can go stale: it re-runs preAuthentication on a 401.
			typeOptions: { expirable: true },
		},
	];

	async preAuthentication(
		this: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
	): Promise<IDataObject> {
		const accountId = credentials.accountId as string;
		const tokenUrl = tokenUrlFor(accountId);
		const algorithm = ((credentials.algorithm as SigningAlgorithm) ?? 'ES512') as SigningAlgorithm;
		const privateKey = normalizePrivateKey(credentials.privateKey as string);

		const scopes = credentials.scopes as string[] | string | undefined;
		const scope = Array.isArray(scopes) ? scopes.join(' ') : (scopes ?? 'rest_webservices');

		const issuedAt = Math.floor(Date.now() / 1000);

		const clientAssertion = signJwt(
			algorithm,
			{ alg: algorithm, typ: 'JWT', kid: credentials.certificateId },
			{
				iss: credentials.clientId,
				scope,
				aud: tokenUrl,
				iat: issuedAt,
				// NetSuite rejects assertions valid for more than an hour.
				exp: issuedAt + 3600,
			},
			privateKey,
		);

		const body = new URLSearchParams({
			grant_type: 'client_credentials',
			client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
			client_assertion: clientAssertion,
		}).toString();

		const response = await this.helpers.httpRequest({
			method: 'POST',
			url: tokenUrl,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
		});

		const data = (typeof response === 'string' ? JSON.parse(response) : response) as IDataObject;

		if (!data?.access_token) {
			throw new Error(
				`NetSuite did not return an access token. Response: ${JSON.stringify(data)}`,
			);
		}

		return { accessToken: data.access_token as string };
	}

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.accessToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL:
				'={{"https://" + $credentials.accountId.trim().toLowerCase().split("_").join("-") + ".suitetalk.api.netsuite.com"}}',
			url: '/services/rest/record/v1/metadata-catalog',
			method: 'GET',
			headers: { Accept: 'application/schema+json' },
		},
	};
}
