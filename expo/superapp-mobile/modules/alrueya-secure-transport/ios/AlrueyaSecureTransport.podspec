Pod::Spec.new do |s|
  s.name           = 'AlrueyaSecureTransport'
  s.version        = '0.1.0'
  s.summary        = 'Non-exportable P-256 device proof for Alrueya Super App.'
  s.description    = 'A local Expo Module that owns a non-exportable P-256 device proof key.'
  s.license        = { :type => 'Proprietary' }
  s.author         = { 'Alrueya' => 'engineering@alrueya.local' }
  s.homepage       = 'https://alrueya.online'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/ahrrfy/business_management_system.git' }
  s.static_framework = true
  s.frameworks = 'Security', 'CryptoKit'
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
end
