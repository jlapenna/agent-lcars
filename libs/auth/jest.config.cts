module.exports = {
  displayName: 'auth',
  preset: '../../jest.preset.js',
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
    '^.+\\.[tj]sx?$': ['babel-jest', { presets: [['@babel/preset-env', {targets: {node: 'current'}}], ['@babel/preset-react', {runtime: 'automatic'}], '@babel/preset-typescript'] }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/libs/auth',
  setupFilesAfterEnv: ['<rootDir>/test-setup.ts'],
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^next-auth/react$': '<rootDir>/__mocks__/next-auth-react.ts',
  },
};
