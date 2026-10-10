// ============================================================
// 模擬資料（mock 模式使用）— 以台北為示範
// 正式模式串 Google Places / Directions 後，本檔不再被使用
// ============================================================
const MOCK = {
  // 景點（Autocomplete / Text Search 來源）
  spots: [
    { placeId: 'm-101', name: '台北101觀景台', address: '台北市信義區信義路五段7號', lat: 25.0339, lng: 121.5645, rating: 4.5, reviews: 68000, indoor: true },
    { placeId: 'm-cks', name: '中正紀念堂', address: '台北市中正區中山南路21號', lat: 25.0347, lng: 121.5216, rating: 4.6, reviews: 62000, indoor: false },
    { placeId: 'm-lungshan', name: '龍山寺', address: '台北市萬華區廣州街211號', lat: 25.0372, lng: 121.4999, rating: 4.5, reviews: 41000, indoor: false },
    { placeId: 'm-ximen', name: '西門町', address: '台北市萬華區', lat: 25.0421, lng: 121.5079, rating: 4.4, reviews: 25000, indoor: false },
    { placeId: 'm-palace', name: '國立故宮博物院', address: '台北市士林區至善路二段221號', lat: 25.1024, lng: 121.5485, rating: 4.6, reviews: 55000, indoor: true },
    { placeId: 'm-shilin', name: '士林夜市', address: '台北市士林區基河路101號', lat: 25.0880, lng: 121.5241, rating: 4.3, reviews: 88000, indoor: false },
    { placeId: 'm-elephant', name: '象山步道', address: '台北市信義區信義路五段150巷', lat: 25.0273, lng: 121.5709, rating: 4.6, reviews: 21000, indoor: false },
    { placeId: 'm-tamsui', name: '淡水老街', address: '新北市淡水區中正路', lat: 25.1699, lng: 121.4384, rating: 4.3, reviews: 33000, indoor: false },
    { placeId: 'm-dadaocheng', name: '大稻埕碼頭', address: '台北市大同區民生西路底', lat: 25.0561, lng: 121.5077, rating: 4.4, reviews: 12000, indoor: false },
    { placeId: 'm-beitou', name: '北投溫泉博物館', address: '台北市北投區中山路2號', lat: 25.1367, lng: 121.5064, rating: 4.4, reviews: 15000, indoor: true },
    { placeId: 'm-maokong', name: '貓空纜車', address: '台北市文山區新光路二段8號', lat: 24.9964, lng: 121.5763, rating: 4.4, reviews: 27000, indoor: false },
    { placeId: 'm-zoo', name: '台北市立動物園', address: '台北市文山區新光路二段30號', lat: 24.9986, lng: 121.5810, rating: 4.5, reviews: 60000, indoor: false },
    { placeId: 'm-huashan', name: '華山1914文創園區', address: '台北市中正區八德路一段1號', lat: 25.0442, lng: 121.5294, rating: 4.4, reviews: 42000, indoor: false },
    { placeId: 'm-songshan-ccp', name: '松山文創園區', address: '台北市信義區光復南路133號', lat: 25.0436, lng: 121.5605, rating: 4.4, reviews: 30000, indoor: false },
    { placeId: 'm-ningxia', name: '寧夏夜市', address: '台北市大同區寧夏路', lat: 25.0554, lng: 121.5155, rating: 4.4, reviews: 35000, indoor: false },
    { placeId: 'm-raohe', name: '饒河街觀光夜市', address: '台北市松山區饒河街', lat: 25.0510, lng: 121.5773, rating: 4.4, reviews: 48000, indoor: false }
  ],

  // 室內景點（雨天備案 Nearby Search 來源）
  indoorSpots: [
    { placeId: 'm-in-1', name: '國立臺灣博物館', address: '台北市中正區襄陽路2號', lat: 25.0428, lng: 121.5150, rating: 4.4, reviews: 9800, type: 'museum' },
    { placeId: 'm-in-2', name: '台北市立美術館', address: '台北市中山區中山北路三段181號', lat: 25.0724, lng: 121.5246, rating: 4.5, reviews: 12000, type: 'art_gallery' },
    { placeId: 'm-in-3', name: '誠品信義店', address: '台北市信義區松高路11號', lat: 25.0400, lng: 121.5651, rating: 4.5, reviews: 26000, type: 'shopping_mall' },
    { placeId: 'm-in-4', name: 'Xpark 水族館', address: '桃園市中壢區春德路105號', lat: 25.0130, lng: 121.2153, rating: 4.3, reviews: 31000, type: 'aquarium' },
    { placeId: 'm-in-5', name: '袖珍博物館', address: '台北市中山區建國北路一段96號', lat: 25.0503, lng: 121.5370, rating: 4.4, reviews: 5200, type: 'museum' },
    { placeId: 'm-in-6', name: '奇美博物館台北特展館', address: '台北市中正區', lat: 25.0410, lng: 121.5180, rating: 4.3, reviews: 3100, type: 'museum' },
    { placeId: 'm-palace', name: '國立故宮博物院', address: '台北市士林區至善路二段221號', lat: 25.1024, lng: 121.5485, rating: 4.6, reviews: 55000, type: 'museum' },
    { placeId: 'm-in-7', name: '微風南山 atré', address: '台北市信義區松智路17號', lat: 25.0355, lng: 121.5672, rating: 4.3, reviews: 15000, type: 'shopping_mall' }
  ],

  // 飯店（lodging Nearby / Text Search 來源；含「福容大飯店」連鎖示範多分館）
  hotels: [
    { placeId: 'm-h-1', name: '台北君悅酒店', address: '台北市信義區松壽路2號', lat: 25.0360, lng: 121.5637, rating: 4.5, reviews: 12000, phone: '02-2720-1234' },
    { placeId: 'm-h-2', name: '寒舍艾美酒店', address: '台北市信義區松仁路38號', lat: 25.0374, lng: 121.5665, rating: 4.5, reviews: 8600, phone: '02-6622-8000' },
    { placeId: 'm-h-3', name: '福容大飯店 台北一館', address: '台北市中正區建國南路一段266號', lat: 25.0378, lng: 121.5379, rating: 4.2, reviews: 4300, phone: '02-2701-9266' },
    { placeId: 'm-h-4', name: '福容大飯店 台北二館', address: '台北市深坑區北深路三段236號', lat: 25.0021, lng: 121.6183, rating: 4.3, reviews: 3900, phone: '02-7706-7788' },
    { placeId: 'm-h-5', name: '福容大飯店 淡水漁人碼頭', address: '新北市淡水區觀海路83號', lat: 25.1832, lng: 121.4108, rating: 4.4, reviews: 11000, phone: '02-2628-7777' },
    { placeId: 'm-h-6', name: '西門町意舍酒店', address: '台北市萬華區武昌街二段77號', lat: 25.0447, lng: 121.5045, rating: 4.4, reviews: 5200, phone: '02-2375-5111' },
    { placeId: 'm-h-7', name: '北投麗禧溫泉酒店', address: '台北市北投區幽雅路30號', lat: 25.1372, lng: 121.5117, rating: 4.6, reviews: 4800, phone: '02-2898-8888' },
    { placeId: 'm-h-8', name: '台北凱撒大飯店', address: '台北市中正區忠孝西路一段38號', lat: 25.0461, lng: 121.5157, rating: 4.2, reviews: 7200, phone: '02-2311-5151' },
    { placeId: 'm-h-9', name: '士林萬麗酒店', address: '台北市士林區中山北路五段470巷', lat: 25.0957, lng: 121.5262, rating: 4.5, reviews: 3600, phone: '02-2885-3888' },
    { placeId: 'm-h-10', name: '誠品行旅', address: '台北市信義區菸廠路98號', lat: 25.0435, lng: 121.5620, rating: 4.5, reviews: 4100, phone: '02-6626-2888' }
  ],

  // 餐廳（restaurant Nearby 來源）
  restaurants: [
    { placeId: 'm-r-1', name: '鼎泰豐 101店', address: '台北市信義區市府路45號', lat: 25.0336, lng: 121.5648, rating: 4.5, reviews: 21000, price: 3, kind: '中式/小籠包' },
    { placeId: 'm-r-2', name: '金峰滷肉飯', address: '台北市中正區羅斯福路一段10號', lat: 25.0322, lng: 121.5187, rating: 4.2, reviews: 15000, price: 1, kind: '台式小吃' },
    { placeId: 'm-r-3', name: '阜杭豆漿', address: '台北市中正區忠孝東路一段108號', lat: 25.0442, lng: 121.5250, rating: 4.3, reviews: 26000, price: 1, kind: '早餐' },
    { placeId: 'm-r-4', name: '林東芳牛肉麵', address: '台北市中山區八德路二段322號', lat: 25.0478, lng: 121.5437, rating: 4.3, reviews: 12000, price: 2, kind: '牛肉麵' },
    { placeId: 'm-r-5', name: '寧夏夜市方家雞肉飯', address: '台北市大同區寧夏路', lat: 25.0556, lng: 121.5153, rating: 4.4, reviews: 6800, price: 1, kind: '台式小吃' },
    { placeId: 'm-r-6', name: '欣葉台菜 創始店', address: '台北市中山區雙城街34-1號', lat: 25.0637, lng: 121.5238, rating: 4.4, reviews: 8900, price: 3, kind: '台菜' },
    { placeId: 'm-r-7', name: '添好運 台北車站店', address: '台北市中正區忠孝西路一段36號', lat: 25.0460, lng: 121.5163, rating: 4.3, reviews: 9400, price: 2, kind: '港式' },
    { placeId: 'm-r-8', name: '士林夜市豪大大雞排', address: '台北市士林區基河路101號', lat: 25.0882, lng: 121.5243, rating: 4.2, reviews: 11000, price: 1, kind: '夜市小吃' },
    { placeId: 'm-r-9', name: 'MUME', address: '台北市大安區四維路28號', lat: 25.0332, lng: 121.5364, rating: 4.4, reviews: 2100, price: 4, kind: '創意料理' },
    { placeId: 'm-r-10', name: '護理長的店滷味', address: '台北市信義區', lat: 25.0350, lng: 121.5600, rating: 4.5, reviews: 5400, price: 1, kind: '滷味' },
    { placeId: 'm-r-11', name: '淡水阿給老店', address: '新北市淡水區真理街6-1號', lat: 25.1746, lng: 121.4330, rating: 4.1, reviews: 7800, price: 1, kind: '台式小吃' },
    { placeId: 'm-r-12', name: '故宮晶華', address: '台北市士林區至善路二段221號', lat: 25.1019, lng: 121.5482, rating: 4.3, reviews: 3200, price: 3, kind: '中式' }
  ]
};
