#!/usr/bin/env node

/**
 * Authentication Test Script
 * Tests the fixed authentication endpoints to verify login functionality
 */

const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'http://localhost:3000/api';

// Test data
const testCredentials = {
  register: {
    username: 'testuser123',
    email: 'test123@example.com', 
    password: 'testpass123'
  },
  login: {
    email: 'test123@example.com',
    password: 'testpass123'
  },
  adminLogin: {
    email: 'user@azaman.com',
    password: 'password123'
  }
};

async function testAuth() {
  console.log('🧪 Starting Authentication Tests...\n');

  try {
    // Test 1: Registration
    console.log('1️⃣ Testing Registration...');
    try {
      const registerResponse = await axios.post(`${BASE_URL}/auth/register`, testCredentials.register);
      console.log('✅ Registration Success:', registerResponse.data.message);
    } catch (error) {
      if (error.response?.status === 400 && error.response.data.message.includes('already')) {
        console.log('ℹ️ User already exists, skipping registration');
      } else {
        console.log('❌ Registration Failed:', error.response?.data || error.message);
      }
    }

    // Test 2: Normal Login
    console.log('\n2️⃣ Testing Normal Login...');
    try {
      const loginResponse = await axios.post(`${BASE_URL}/auth/login`, testCredentials.login);
      console.log('✅ Login Success:', {
        message: loginResponse.data.message,
        user: loginResponse.data.user,
        tokenExists: !!loginResponse.data.token
      });
      
      // Test protected endpoint
      const token = loginResponse.data.token;
      const userDetailsResponse = await axios.get(`${BASE_URL}/auth/me/${loginResponse.data.user.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log('✅ Protected endpoint access successful');
      
    } catch (error) {
      console.log('❌ Login Failed:', error.response?.data || error.message);
    }

    // Test 3: Admin Login
    console.log('\n3️⃣ Testing Admin Login...');
    try {
      const adminLoginResponse = await axios.post(`${BASE_URL}/auth/login`, testCredentials.adminLogin);
      console.log('✅ Admin Login Success:', {
        message: adminLoginResponse.data.message,
        userRole: adminLoginResponse.data.user.role,
        tokenExists: !!adminLoginResponse.data.token
      });
    } catch (error) {
      console.log('❌ Admin Login Failed:', error.response?.data || error.message);
    }

    // Test 4: Invalid Login
    console.log('\n4️⃣ Testing Invalid Login...');
    try {
      await axios.post(`${BASE_URL}/auth/login`, {
        email: 'invalid@example.com',
        password: 'wrongpassword'
      });
      console.log('❌ Invalid login should have failed!');
    } catch (error) {
      if (error.response?.status === 401) {
        console.log('✅ Invalid login correctly rejected');
      } else {
        console.log('⚠️ Unexpected error:', error.response?.data || error.message);
      }
    }

    // Test 5: Missing Fields
    console.log('\n5️⃣ Testing Validation...');
    try {
      await axios.post(`${BASE_URL}/auth/login`, {
        email: '',
        password: ''
      });
      console.log('❌ Empty fields should have been rejected!');
    } catch (error) {
      if (error.response?.status === 400) {
        console.log('✅ Input validation working correctly');
      } else {
        console.log('⚠️ Unexpected validation error:', error.response?.data || error.message);
      }
    }

  } catch (error) {
    console.error('💥 Test suite failed:', error.message);
  }

  console.log('\n🏁 Authentication tests completed!');
}

// Run tests if server is running
axios.get(`${BASE_URL}/auth/settings/rates`)
  .then(() => {
    console.log('🚀 Server is running, starting tests...\n');
    testAuth();
  })
  .catch(() => {
    console.log('❌ Server not running on http://localhost:3000');
    console.log('💡 Start the server with: npm start');
  });