import en from '../public/_locales/en/messages.json';
import ko from '../public/_locales/ko/messages.json';
let language = 'ko';
export async function loadUiLanguage(value) {
  language = value === 'auto' ? (globalThis.navigator?.language || 'en').split('-')[0] : value || 'ko';
}
export function getMessage(key) { return (language === 'ko' ? ko[key]?.message : '') || en[key]?.message || ''; }
export function getUiLangCode() { return language; }
export function t(key) { return getMessage(key) || key; }
