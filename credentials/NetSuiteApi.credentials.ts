import { ICredentialType, INodeProperties, Icon } from 'n8n-workflow'; // , ICredentialTestRequest

export class NetSuiteApi implements ICredentialType {
	name = 'netSuiteApi';
	// extends = ['oAuth1Api'];
	displayName = 'NetSuite API';
	documentationUrl = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4636903496.html';
	icon: Icon = 'file:../icons/netsuite.svg';
	properties: INodeProperties[] = [
		{
			displayName: 'Account ID',
			name: 'realm',
			type: 'string',
			default: '',
			required: true,
			placeholder: '1234567_SB1',
			description: 'Your account ID (Includes Suffix if exists). Use underscore instead of dash.',
		},
		{
			displayName: 'Consumer Key',
			name: 'consumerKey',
			type: 'string',
			required: true,
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Consumer Secret',
			name: 'consumerSecret',
			type: 'string',
			required: true,
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Access token',
			name: 'token',
			type: 'string',
			required: true,
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Token Secret',
			name: 'tokenSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Signature Method',
			name: 'signatureMethod',
			type: 'string',
			default: "HMAC-SHA256",
			description: 'The signature method to use for OAuth 1.0a authentication. Must be HMAC-SHA256 for NetSuite API.',
			options: [
				{ name: 'HMAC-SHA256', value: 'HMAC-SHA256' }
			]
		}
	];
	// test: ICredentialTestRequest = {
	// 	request: {
	// 		baseURL: 'https://${accountUrlPart}.suitetalk.api.netsuite.com',
	// 		url: '/services/rest/system/v1/serverTime',
	// 		method: 'GET',
	// 	},
	// };
}