// ============================================================================
// British English pronunciation "trap" words — RP (Received Pronunciation).
// Used by the Pronunciation Coach (Level A).
// ============================================================================

export interface BritishTrap {
  word: string
  ipa: string
  note: string // short coaching hint about the British vs American difference
}

export const BRITISH_TRAPS: BritishTrap[] = [
  { word: 'schedule', ipa: '/ˈʃedjuːl/', note: "First syllable sounds like 'sheh' (/ʃ/), not 'ske' (/sk/)." },
  { word: "can't", ipa: '/kɑːnt/', note: 'Long /ɑː/ as in "father", NOT /æ/. Rhymes with "aunt".' },
  { word: 'water', ipa: '/ˈwɔːtə/', note: 'British has a long /ɔː/ and a silent non-rhotic final /ə/.' },
  { word: 'dance', ipa: '/dɑːns/', note: 'Southern/BBC: /ɑː/ (as in father), not /æ/. Northern accent may differ.' },
  { word: 'either', ipa: '/ˈaɪðə/', note: 'Often begins with /aɪ/ (like "eye-thuh"), British preference.' },
  { word: 'hot', ipa: '/hɒt/', note: 'Short /ɒ/ — a more open, rounded vowel than American /ɑː/.' },
  { word: 'dog', ipa: '/dɒɡ/', note: '/ɒ/ again — British "dog" rhymes roughly with "cot".' },
  { word: 'tomato', ipa: '/təˈmɑːtəʊ/', note: 'British /ɑː/ + final /əʊ/, unlike American /eɪ/.' },
  { word: 'garage', ipa: '/ˈɡærɑːʒ/', note: 'Stress on first syllable in UK: GAR-ahj.' },
  { word: 'bath', ipa: '/bɑːθ/', note: 'Long /ɑː/ — "bahth", not "bæth".' },
  { word: 'herb', ipa: '/hɜːb/', note: 'British pronounces the initial /h/: "hurb".' },
  { word: 'address', ipa: '/əˈdres/', note: 'British stress is on the second syllable: uh-DRESS.' },
  { word: 'mobile', ipa: '/ˈməʊbaɪl/', note: 'Final syllable /baɪl/ ("bile"), not /bəl/.' },
  { word: 'controversy', ipa: '/kənˈtrɒvəsi/', note: 'British commonly stresses the second syllable.' },
  { word: 'route', ipa: '/ruːt/', note: 'British long /uː/ — "root", though /raʊt/ appears in transport.' },
  { word: 'zebra', ipa: '/ˈzebrə/', note: 'British short /e/: "ZEB-ruh", not "ZEE-bruh".' },
  { word: 'privacy', ipa: '/ˈprɪvəsi/', note: 'British short /ɪ/: "PRIV-uh-see".' },
  { word: 'squirrel', ipa: '/ˈskwɪrəl/', note: 'Note /w/ then short /ɪ/: "SKWIR-ruhl" — two syllables.' },
  { word: 'often', ipa: '/ˈɒfən/', note: 'Traditionally the /t/ is silent in conservative RP: "offen".' },
  { word: 'leisure', ipa: '/ˈleʒə/', note: 'First vowel /e/ ("LEH-zhuh"), unlike American /liː/.' },
  { word: 'apparatus', ipa: '/ˌæpəˈreɪtəs/', note: 'Second /eɪ/ ("APP-uh-RAY-tus") is the usual UK pronunciation.' },
  { word: 'aluminium', ipa: '/ˌæljəˈmɪniəm/', note: 'British spelling/pronunciation: "al-u-MIN-ee-um".' },
]
