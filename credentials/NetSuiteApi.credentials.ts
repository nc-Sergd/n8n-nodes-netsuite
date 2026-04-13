import { ICredentialType, INodeProperties, Icon } from 'n8n-workflow'; // , ICredentialTestRequest

export class NetSuiteApi implements ICredentialType {
	name = 'netSuiteApi';
	displayName = 'NetSuite API';
	documentationUrl = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4636903496.html';
	icon: Icon = 'file:../icons/netsuite.svg';
	properties: INodeProperties[] = [
		{
			displayName: 'Account ID',
			name: 'account',
			type: 'string',
			default: '',
			placeholder: '1234567_SB1',
			description: 'Your account ID (Includes Suffix if exists). Use underscore instead of dash.',
		},
		{
			displayName: 'Consumer Key',
			name: 'consumerKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Consumer Secret',
			name: 'consumerSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Token ID',
			name: 'tokenId',
			type: 'string',
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
	];
	// test: ICredentialTestRequest = {
	// 	request: {
	// 		baseURL: 'https://${accountUrlPart}.suitetalk.api.netsuite.com',
	// 		url: '/services/rest/system/v1/serverTime',
	// 		method: 'GET',
	// 	},
	// };
}