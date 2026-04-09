import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class NetSuiteApi implements ICredentialType {
	name = 'netSuiteApi';
	displayName = 'NetSuite API';
	documentationUrl = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1544076742.html';
	properties: INodeProperties[] = [
		{
			displayName: 'Account ID',
			name: 'account',
			type: 'string',
			default: '',
			placeholder: '1234567_SB1',
			description: 'ID вашего аккаунта (включая суффикс Sandbox, если есть). Используйте подчеркивание.',
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
}